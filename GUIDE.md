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
3. Type message template using `{name}` etc. Select text and hit **B / I / S / { }** to wrap it in WhatsApp's own formatting (`*bold*`, `_italic_`, `~strike~`, ` ```mono``` `), or the 🔗 button to insert a link — the preview below renders it live, and shows even before any recipients are loaded.
4. (Optional) Attach media — **Upload File** tab picks a local image/video (max 7MB — see size note below); **Paste Link** tab uses a URL instead (up to 100MB, since it's fetched fresh each send rather than stored). Leave both empty for text-only.
5. (Optional) Check **Send as Document** to skip WhatsApp's own video/photo compression — sends the original file untouched, at the cost of it appearing as a file attachment rather than an inline media preview. Experimental — see note below.
6. Set delays (defaults are fine).
7. Click **Start Processing**.

## CSV format
```
phone,name,company
15550199,John,Acme Corp
15550288,Jane,Widget Co
```
- Comma `,` — separates fields **within** one recipient's row (same row).
- New line (Enter) — starts the **next** recipient's row.
- First row is the header — those names become the `{tags}` you can use in the template (`{name}`, `{company}`, etc). Column names must match the `{tag}` exactly, no spaces.

## Copy Shareable Link
Turns your current message into a `wa.me` click-to-chat link (compiled against recipient #1) and copies it to your clipboard — for sharing outside the automated queue, e.g. in an email or a post. If **Send Test To** has a phone number, the link opens straight to that chat; otherwise it opens WhatsApp's contact picker with the message pre-filled.

---

## Heads up: permission prompt
Chrome will ask for access to **all sites**, not just WhatsApp. That's needed for the **Paste Link** tab, so the extension can fetch your media URL without being blocked by CORS. The **Upload File** tab doesn't need it — the file goes straight from your disk to WhatsApp.

## Media send is best-effort
Attaching image/video works by faking a file-drop into WhatsApp's chat window. WhatsApp can change their page layout anytime, which can break this silently — if it does, the task fails and retries (shows up in the Failed count), it won't hang forever. Plain text messages don't depend on this and are far more reliable.

## Why Upload File caps at 7MB but Paste Link goes to 100MB
An uploaded file has to survive WhatsApp reloading the page between every message in a batch (each recipient is a different chat, so nearly every send reloads the tab) — the only place that can hold it across that reload is `chrome.storage.session`, which Chrome hard-caps at 10MB no matter what, so 7MB raw is the real practical ceiling for **Upload File**.

**Paste Link** doesn't have this problem: the extension re-fetches the URL fresh right when it's about to send, after any reload, so it's never sitting in that 10MB storage. For real HD video, host it somewhere (Drive, Dropbox, your own server — anywhere that gives a direct link) and use **Paste Link** instead of **Upload File**.

## Send as Document (experimental)
This targets WhatsApp Web's "Document" attach button specifically, which is where their no-compression path lives — unlike the rest of this extension's selectors, I can't verify this one against a live WhatsApp session, so it's the most likely thing to break first if WhatsApp changes their attach menu. If it fails, the task fails clearly (shows in Failed) rather than silently falling back to compressed sending.

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
