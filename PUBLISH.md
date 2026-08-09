# Publish to Chrome Web Store

## 1. Zip already built
`enterprise-outreach-engine.zip` in project root — `manifest.json` at zip root (required), no `website/`/`.git`/docs inside.

Made changes since? Rebuild:
```
zip -r enterprise-outreach-engine.zip manifest.json assets background content core sidepanel -x "*.DS_Store"
```

## 2. Developer Dashboard
1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) — one-time $5 registration if first extension.
2. **New Item** → drag `enterprise-outreach-engine.zip` onto the "Drop a ZIP or CRX file here" box.

## 3. Store listing tab
- **Description**: short pitch — CSV bulk WhatsApp send, rate-limited, media attach.
- **Icon**: already bundled (128px) from the zip.
- **Screenshots**: at least 1 required (1280x800 or 640x400) — screenshot the side panel in use.
- **Homepage URL**: `https://devlopersfield.github.io/Whatapp-bulk/`
- **Privacy policy URL**: `https://devlopersfield.github.io/Whatapp-bulk/privacy.html`

## 4. Privacy practices tab
Declare data usage matching what's actually in the privacy page: no data sold, no analytics, local-only storage (`chrome.storage.local`/`session`). Justify **host permission (all sites)** with one line: "Paste Link media feature fetches user-supplied URLs, bypassing page CORS."

## 5. Submit for review
**Submit for Review** button. Typical review: a few hours to a few days. First-time publisher review tends to run longer.

## Reminders
- Icon-128 already square/transparent — fine as-is.
- If you change `manifest.json` version, bump `"version"` before rezipping — Store rejects a re-upload with the same version number.
