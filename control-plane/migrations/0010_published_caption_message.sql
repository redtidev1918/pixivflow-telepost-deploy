-- The id of the published TEXT message.
--
-- A published review is two messages in the channel: the media, then the text. The
-- ledger recorded only the media's id, so "did the post keep the reviewer's layout"
-- was not answerable from state — the same class of gap as the review side had before
-- migration 0009 split media / text / control card.
ALTER TABLE reviews ADD COLUMN published_caption_message_id INTEGER;
