#!/usr/bin/env python3
"""Mock PixivFlow producer implementing the bare minimum of Workflow Protocol v1.

Only used to smoke-test scripts/verify-protocol-v1.py --live without touching production.

  MODE=ok       (default) queued → running → succeeded
  MODE=stuck              never leaves running (must be reported as 停摆)
  MODE=refetch            succeeds but leaks a refetch_* field name (guard must fire)
  MODE=badcapabilities    capabilities misses candidate_search (guard must fire)
  MODE=noevents           terminal job with an empty event stream (guard must fire)
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

def _canon(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


MODE = os.environ.get("MODE", "ok")
JOBS: dict[str, dict] = {}
BY_KEY: dict[str, str] = {}
POLLS: dict[str, int] = {}
EVENTS: dict[str, list[str]] = {}
ACKED: dict[str, str] = {}


def now_ms() -> int:
    return int(time.time() * 1000)


def capabilities() -> dict:
    declarations = [] if MODE == "badcapabilities" else [{
        "name": "candidate_search",
        "params_schema": "#/$defs/CandidateSearchParams",
        "result_schema": "#/$defs/Result_CandidateSearch",
        "features": ["events", "progress", "cancel", "idempotency", "exclude", "tag_expansion"],
        "queued_timeout_ms": 1800000,
        "stall_timeout_ms": 900000,
        "heartbeat_interval_ms": 30000,
        "default_deadline_ms": 5400000,
    }]
    return {"protocol_versions": ["1"], "job_types": declarations, "server_time": now_ms()}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep the smoke output readable
        pass

    def _send(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/capabilities":
            return self._send(200, capabilities())
        if self.path.startswith("/jobs/") and self.path.split("?")[0].endswith("/events"):
            job_id = self.path.split("?")[0].split("/")[-2]
            job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": {"code": "not_found", "message": "unknown job"}})
            if MODE == "noevents":
                return self._send(200, {"job_id": job_id, "events": [], "unacked": 0, "server_time": now_ms()})
            events = [
                {"protocol_version": "1", "event_id": f"evt-accepted-{job_id}", "job_id": job_id,
                 "type": "job.accepted", "at": job.get("created_at"), "correlation_id": job.get("correlation_id")},
                {"protocol_version": "1", "event_id": f"evt-started-{job_id}", "job_id": job_id,
                 "type": "job.started", "at": job.get("started_at") or job.get("created_at"),
                 "correlation_id": job.get("correlation_id")},
            ]
            if job.get("status") in ("succeeded", "failed", "cancelled", "expired"):
                events.append({
                    "protocol_version": "1", "event_id": f"evt-terminal-{job_id}", "job_id": job_id,
                    "type": f"job.{job['status']}", "at": now_ms(), "correlation_id": job.get("correlation_id"),
                    "payload": {"job": job, "error": job.get("error")},
                })
            EVENTS[job_id] = [item["event_id"] for item in events]
            acked = ACKED.get(job_id)
            unacked = 0 if acked else len(events)
            return self._send(200, {"job_id": job_id, "events": events, "next_after": "",
                                    "unacked": unacked, "server_time": now_ms()})
        if self.path.startswith("/jobs/"):
            job_id = self.path.rsplit("/", 1)[-1].split("?")[0]
            job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": {"code": "not_found", "message": "unknown job"}})
            POLLS[job_id] = POLLS.get(job_id, 0) + 1
            if MODE == "stuck":
                job["status"] = "running"
            elif POLLS[job_id] >= 2:
                job["status"] = "succeeded"
                job["result"] = {"candidates": [], "scanned": 4, "filtered": [{"work_id": "149713091", "reason": "excluded"}]}
            else:
                job["status"] = "running"
            job["updated_at"] = now_ms()
            if job["status"] == "running":
                job["heartbeat_at"] = now_ms()
                job["lease_active"] = True
            if MODE == "refetch":
                job["refetch_request_id"] = "leaked"
            return self._send(200, job)
        return self._send(404, {"error": {"code": "not_found"}})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/jobs":
            if body.get("job_type") != "candidate_search":
                return self._send(400, {"error": {"code": "invalid_params", "message": "unknown job_type"}})
            key = body.get("idempotency_key") or f"auto-{len(JOBS)}"
            if key in BY_KEY:
                existing = JOBS[BY_KEY[key]]
                same = _canon(existing.get("params")) == _canon(body.get("params"))
                if not same:
                    return self._send(409, {"error": {
                        "code": "idempotency_conflict",
                        "message": "this idempotency_key was already used with different params",
                        "retryable": False}})
                return self._send(200, existing)
            job_id = f"job-{len(JOBS) + 1}"
            BY_KEY[key] = job_id
            JOBS[job_id] = {
                "protocol_version": "1",
                "job_id": job_id,
                "job_type": "candidate_search",
                "status": "queued",
                "idempotency_key": key,
                "correlation_id": body.get("correlation_id"),
                "params": body.get("params"),
                "created_at": now_ms(),
                "updated_at": now_ms(),
                "deadline_at": now_ms() + 5400000,
            }
            return self._send(202, JOBS[job_id])
        if self.path.endswith("/events/ack"):
            if MODE == "noack":
                return self._send(404, {"error": {"code": "not_found", "message": "no ack surface"}})
            job_id = self.path.split("/")[-3]
            job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": {"code": "not_found"}})
            known = EVENTS.get(job_id) or []
            cursor = body.get("ack_through") or ""
            if cursor in known:
                ACKED[job_id] = cursor
            acked = known.index(cursor) + 1 if cursor in known else (len(known) if ACKED.get(job_id) else 0)
            return self._send(200, {"job_id": job_id, "acked": acked,
                                    "unacked": max(0, len(known) - acked), "server_time": now_ms()})
        if self.path.endswith("/cancel"):
            job_id = self.path.split("/")[-2]
            job = JOBS.get(job_id)
            if not job:
                return self._send(404, {"error": {"code": "not_found"}})
            job["status"] = "cancelled"
            job["updated_at"] = now_ms()
            job["error"] = {"code": "cancelled_by_consumer", "retryable": False}
            return self._send(200, job)
        return self._send(404, {"error": {"code": "not_found"}})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8799"))
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
