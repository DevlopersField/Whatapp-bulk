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
2. In side panel: paste CSV → `phone,name` header, one row per line.
3. Type message template using `{name}` etc.
4. Set delays (defaults are fine).
5. Click **Start Processing**.

---

## Made a code change?
Go back to `chrome://extensions` → click the 🔄 reload icon on the extension card.
(Content script changes need the WhatsApp tab refreshed too.)

## Something broke?
`chrome://extensions` → **Errors** button on the card shows the stack trace.
