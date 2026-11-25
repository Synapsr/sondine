-- Phonetic search (M4) reads the words the index holds, live: a word whose
-- last segment was deleted leaves this view with it, so no copy of deleted
-- text is kept anywhere.
CREATE VIRTUAL TABLE `segments_vocab` USING fts5vocab('segments_fts', 'row');
