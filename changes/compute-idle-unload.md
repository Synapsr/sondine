---
type: fixed
---

## Your own server keeps the model as long as you say

`SONDINE_COMPUTE_IDLE_UNLOAD_SEC` now sets how long your transcription server keeps the model after its last request, and `0` keeps it loaded, so a conversation starts at once. The server used to let go of it after three minutes, whatever the setting said. Its README also shows how to bound its memory on a machine that does other work.
