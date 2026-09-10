-- Keep the three kinds of review message apart.
--
-- A review is three different things and the old schema collapsed two of them:
--
--   media_message_ids   the files, in order: one album or several consecutive groups
--   caption_message_id  the work's text, sent AFTER all media
--   control_message_id  the approve/reject card, never published
--
-- `message_ids` held the media and `message_id` held whichever message carried the
-- keyboard. Those are still populated for compatibility, but publishing has to be able
-- to reproduce the layout in the channel — media first, then the text — and an
-- ambiguous array cannot express that.
--
-- Backfill: before this, the media were `message_ids` and the keyboard sat on the
-- first of them, so the existing rows map cleanly.
ALTER TABLE reviews ADD COLUMN media_message_ids TEXT;
ALTER TABLE reviews ADD COLUMN caption_message_id INTEGER;
ALTER TABLE reviews ADD COLUMN control_message_id INTEGER;

UPDATE reviews SET media_message_ids = message_ids WHERE media_message_ids IS NULL;
UPDATE reviews SET control_message_id = message_id WHERE control_message_id IS NULL;
