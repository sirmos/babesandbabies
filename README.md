# Babes & Babies

A hair and baby products shop in Ekim Town, Mkpat Enin, Akwa Ibom State, Nigeria. Customers can **see a hairstyle on themselves before they book**, get a **skin report with product picks**, and chat with AI assistants in English and Nigerian Pidgin.

**Live site:** https://babesandbabies-dcb39.web.app
**AI Shop Assistant:** https://babesandbabies-dcb39.web.app/shop.html
**AI Try-On page:** https://babesandbabies-dcb39.web.app/tryon.html
**Built for:** YouCam API Skin AI & eCommerce VTO Hackathon

## What was already here, and what is new

| Already built (shop site) | New in this project (YouCam) |
|---|---|
| AI Hair Stylist (Google Gemini) that recommends hairstyles from customer preferences | AI Hair Try-On with the YouCam AI Hairstyle API |
| AI Baby Advisor (Google Gemini) that recommends baby products by baby age and needs | AI Skin Analysis with the YouCam Skin Analysis API |
| English and Nigerian Pidgin support | Before/after slider, style search, and a QR-code entry for in-store use |
| WhatsApp ordering and appointment booking | Homepage gallery driven by one data file, plus optional salon hair-transfer |

---

## The problem

Braids take 4 to 8 hours and cost real money. Customers often walk in unsure, scroll through photos of other people, and sometimes leave unhappy with the result. The shop loses bookings to hesitation, and customers lose time and money to a style that doesn't suit them.

Skincare shopping for mums has a similar gap. Mums shop for their babies first and rarely get any guidance on their own skin.

## What it does

### 1. AI Hair Try-On
- The customer uploads a front-facing photo, with natural or unmade hair.
- She browses YouCam's hairstyle templates (braids, curls, bobs and more), filters by category, or searches by name, for example "braid".
- She gets a **before/after slider** of herself in the new style.
- One tap opens **WhatsApp with the style name pre-filled**, so a preview turns into a booking.

### 2. AI Skin Analysis (Mum's skin)
- The customer uploads a selfie and gets scores for **radiance, oiliness, texture, pores, acne and moisture**.
- The app recommends **2 to 3 gentle products from the shop's range** for her and her little one. Recommendations come from Gemini, with a rule-based fallback based on the lowest scores, so the customer always gets an answer.
- One tap opens WhatsApp to order.

### 3. Salon gallery (built, optional)
- The homepage hairstyle gallery now runs from a single list, `styles/styles.json`.
- A style can have an optional front-facing `tryOnImage`. Styles that have one appear in the try-on grid and use YouCam's **hair-transfer** endpoint, so the shop's own styles can be tried on.
- This is implemented but not enabled by default, because it needs front-facing reference photos.

### In-store flow
A QR code at the counter opens the try-on page directly. A customer can preview her style, show it to the stylist, and book on the spot.

---

## YouCam APIs used

| API | Endpoint | Used for |
|---|---|---|
| AI Hairstyle (Hair Style) | `POST /s2s/v2.0/task/hair-style`, `GET /s2s/v2.0/task/template/hair-style` | Preset hairstyle try-on, template browsing with pagination |
| AI Skin Analysis | `POST /s2s/v2.0/task/skin-analysis` | Skin scores (acne, moisture, texture, pore, radiance, oiliness) |
| AI Hairstyle Generator (Hair Transfer) | `POST /s2s/v2.1/task/hair-transfer` | Trying on the salon's own style photos (optional) |

All YouCam calls follow the same flow: request an upload URL, upload the image, create the task, poll for the result.

## Architecture

```
Browser (Firebase Hosting)           Cloudflare Worker                 External APIs
 index.html, tryon.html   ───────►   worker/index.js   ───────►   YouCam API
 styles/styles.json                  (holds all API keys)           Gemini 2.5 Flash
```

- **Frontend:** plain HTML, CSS and JavaScript on Firebase Hosting. It is mobile-first, because customers use phones.
- **Backend:** one Cloudflare Worker that proxies YouCam and Gemini, so **no API key is ever exposed to the browser**.
- **Image handling:** photos are resized in the browser (max 1080px, JPEG) before upload, which keeps requests small and avoids format errors from PNG or HEIC phone photos.

## Privacy

Customers are understandably careful with their faces, so the app is designed to keep as little as possible:

- The site has **no database and no user accounts**. The Worker does not save photos.
- Photos are sent only to YouCam to produce the result, and are subject to YouCam's data policy.
- Photos are never used for ads or sold. The customer chooses whether to share any result.
- Try-on is **optional**. Customers can still book normally without it.

## Run it yourself

### Prerequisites
- Node.js, plus the Wrangler and Firebase CLIs (`npm i -g wrangler firebase-tools`)
- A YouCam API key (https://yce.makeupar.com)
- A Google Gemini API key

### Backend (Cloudflare Worker)
```bash
cd worker
wrangler secret put YOUCAM_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler deploy
```
Then set the Worker URL in `tryon.html` (the `WORKER_URL` constant, or wherever your fetch calls point).

### Frontend (Firebase Hosting)
```bash
firebase login
firebase deploy --only hosting
```

### Routes exposed by the Worker
| Route | Method | Purpose |
|---|---|---|
| `/youcam/hair-templates` | GET | Paginated list of YouCam hairstyle templates |
| `/youcam/hair` | POST | Hair try-on with a YouCam template id |
| `/youcam/hair-transfer` | POST | Try-on with a salon reference photo (allow-listed to this site's URLs) |
| `/youcam/skin` | POST | Skin analysis plus product recommendation |
| `/` | POST | Shop chat assistant (Gemini) |
| `/agent/chat` | POST | Shop assistant with a catalogue-validated cart and checkout handoff |
| `/shop/catalog` | GET | Catalogue used by the shop and checkout |

## Adding salon styles
See [`styles/README.md`](styles/README.md). In short, add the display photo to `styles/styles.json`. To make a style try-on-able, also add a front-facing `tryOnImage` (JPG, under 10 MB, long side at most 1024px, one clear face), then run `firebase deploy --only hosting`.

## Known limitations
- AI hair try-on is a generative preview. It approximates a style and can subtly change how the face looks, so the result is shown next to the original, with an "AI preview" note.
- YouCam presets use fixed colors. Pick a dark-colored template to match natural black hair.
- Hair transfer needs a front-facing reference photo, so back or top-view gallery photos can't be used for try-on.

## Roadmap
- Use the shop's own style photos for try-on, once front-facing reference photos are available
- Connect skin results directly to the shop's product catalog with add-to-cart
- Save a favourite style and send it to the stylist before the appointment

## Tech
Cloudflare Workers · Firebase Hosting · YouCam API · Google Gemini (gemini-2.5-flash) · HTML, CSS, JavaScript