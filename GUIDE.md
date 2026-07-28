# Load the Extension (Dev Mode)

## 1. Open extensions page
Chrome → type in address bar:
```
chrome://extensions
```

## 2. Turn on Developer Mode
Top-right toggle. Switch it **ON**.

## 3. Click "Load unpacked"
Button appears top-left after step 2.

## 4. Select this folder
Pick:
```
Whatapp-bulk
```
(the folder with `manifest.json` in it — not a subfolder)

## 5. Pin it
Puzzle-piece icon (top-right of Chrome) → pin **Enterprise Outreach Engine**.

## 6. Open the panel
Click the pinned icon → side panel opens on the right.

---

## Test it
1. Open `web.whatsapp.com`, scan QR, log in.
2. In side panel: paste CSV (`phone,name` header) **or** upload a CSV **or** use "Add Single Phone Number" for one-off adds. Max 100 recipients per batch — extra rows get dropped with a warning.
3. Type message template using `{name}` etc.
4. (Optional) Media URL + type — attaches an image/video to every send. Leave blank for text-only.
5. Set delays (defaults are fine).
6. Click **Start Processing**.

---

## Heads up: permission prompt
Chrome will ask for access to **all sites**, not just WhatsApp. That's needed so the extension can fetch your media URL (photo/video link) without being blocked by CORS. If you never use the Media URL field, this permission just sits unused.

## Media send is best-effort
Attaching image/video works by faking a file-drop into WhatsApp's chat window. WhatsApp can change their page layout anytime, which can break this silently — if it does, the task fails and retries (shows up in the Failed count), it won't hang forever. Plain text messages don't depend on this and are far more reliable.

## Badge says something other than "Connected"
- **No WhatsApp Tab** — open `web.whatsapp.com` in a tab.
- **Scan QR Code** — open WhatsApp on your phone and scan.
- **Reloading...** — extension is re-injecting itself into an already-open tab, click Recheck in a second.
- **Detection Error** — WhatsApp changed their page layout and the extension's detection needs updating; text sends may still work fine, only this status check is affected.

---

## Made a code change?
Go back to `chrome://extensions` → click the 🔄 reload icon on the extension card.
(Content script changes need the WhatsApp tab refreshed too.)

## Something broke?
`chrome://extensions` → **Errors** button on the card shows the stack trace.
