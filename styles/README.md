# Salon Styles

The `image` field is the hairstyle's display photo in the main gallery. To add a style, add its display photo to the `styles.json` list with an ID, title, image path, and tag.

To make a style available in AI Try-On, also add a `tryOnImage` path to a front-facing reference photo with one clear face. Use a JPG under 10 MB with a maximum long side of 1024 px. The image path must be hosted on the site's Firebase domain for the Worker allowlist.

After adding or changing gallery photos or data, run `firebase deploy --only hosting`.