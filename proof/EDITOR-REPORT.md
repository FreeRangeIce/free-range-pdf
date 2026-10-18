# Text-PDF editor report (no private content)
Preview: http://127.0.0.1:8090/app/index.html (node scripts/serve.mjs 8090). Tests: proof/app-test.mjs, proof/app-keyboard-test.mjs, /workspace/pw-tools/frpdf-stress.js all (20 scenarios).
Original (base.pdf) SHA-256: b7e45aa7b7806c9dad3b80daaa4394b306d6ba332ffad1b7cbe0770f3e1c159b - unchanged after edit/undo/failed opens. 0 external requests.

| Hole | Result |
|---|---|
| 1 failed open leaves old doc live | Fixed: every open resets doc first; after failed open edits 0, Download/Undo disabled, lists cleared (shot 11) |
| 2 empty text | Apply blocked with reason, Enter does nothing (shot 12) |
| 3 keyboard-only | Tab reaches Open PDF, Sample, Credits, page line, text box, Details, Undo, Download; arrows move lines; Download by keyboard worked; focus ring (shots 09, 10) |
| 4 beforeunload | Prompt only with undownloaded edits; dialog seen on reload |
| 5 blocked characters | Emoji, zero-width, tab, RTL, Arabic, CJK: short inline mark; long sentence only after Apply pressed; never applied (shots 13, 14) |
| 6 unsupported line wording | "This line can't be edited here. Nothing was changed." (draft) |
| 7 busy | "Working..." flag; Undo/Download disabled while busy |
| 8 password | enc.pdf: password-protected message (draft); owner-only: separate PLACEHOLDER restrictions message |

Shots in proof/app-shots: 01-open, 03-after-edit1, 04-preview-gap, 05-refusal, 06-after-undo, 07-credits, 08-failed-checks-open (verifier fed unedited bytes), 11-failed-open-cleared.
