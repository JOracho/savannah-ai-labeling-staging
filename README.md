# Savannah AI Labeling Website

A responsive, single-page website built with one `index.html` file. HTML, internal CSS and internal JavaScript are all included in that file. It is designed for free GitHub Pages hosting.

## Files
- `index.html` — complete website, styling and interactions.
- `assets/images/` — add approved project images here.
- `assets/logo/` — add your official logo here when available.

## Add your logo
The current header uses a simple text-and-letter placeholder so the website works immediately. Add your logo to `assets/logo/`, then replace the `.brand-mark` element in `index.html` with an image, for example:
`<img src="assets/logo/savannah-logo.png" alt="Savannah AI Labeling" style="height:48px;width:auto">`

## Replace sample-work media
Each project stage currently contains a labelled placeholder. To add an image, replace the contents of a `.media-slot` with:
`<img src="assets/images/your-image.jpg" alt="Descriptive annotation stage">`
Use your own approved images and name them clearly. For a video, use a `<video controls src="assets/images/your-video.mp4"></video>` element.

Suggested filenames are listed in the placeholders in the Sample Work section. The project walkthroughs are illustrative examples, not claims of completed client work.

## Edit text and services
Open `index.html` and search for the heading or text you want to change. Service cards are inside the section with `id="offer"`.

## Connect the forms
GitHub Pages serves static files and does not process form submissions. The two forms currently validate required fields in the browser but do not send data anywhere.

To receive submissions, create two separate forms with a service such as Formspree (check its current free-plan limits and terms). Once you have each endpoint:
1. Change the client form opening tag to include `action="YOUR_CLIENT_FORM_ENDPOINT" method="POST"`.
2. Change the annotator form opening tag to include `action="YOUR_ANNOTATOR_FORM_ENDPOINT" method="POST"`.
3. Replace the current `handleUnconfiguredForm` submit listeners with normal form submission (remove those two `addEventListener` lines and the handler function).
4. Test both forms before sharing the website publicly.

Do not put private API keys or passwords in this public repository.

## Publish with GitHub Pages
1. Create a GitHub repository named `savannah-ai-labeling`.
2. Upload `index.html` and the `assets` folder.
3. Open repository **Settings → Pages**.
4. Under Build and deployment, choose **Deploy from a branch**.
5. Select branch `main` and folder `/ (root)`, then save.
6. Wait for GitHub Pages to publish and use the URL shown in Settings → Pages.

No paid domain or hosting is required. GitHub may apply its own usage limits and terms to free Pages hosting.


This repository is the isolated staging copy for Savannah AI Labeling. It is separate from the production repository.
