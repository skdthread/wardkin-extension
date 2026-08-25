# Wardkin

Chrome extension that blocks distracting websites. Click the popup to add the current site to the block list; visits to blocked sites show a high-opacity grey overlay with a red “This site is blocked” message. The page stays faintly visible underneath in greyscale and cannot be scrolled or interacted with.

## Test it

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this project folder
4. Open any website (for example `https://example.com`)
5. Click the Wardkin extension icon in the toolbar
6. Click **Block this site**
7. Reload the page — you should see a greyed-out overlay with the red message, and the site faintly visible in greyscale behind it
8. Try scrolling or clicking — the page should stay locked
9. Open the popup again and click **Remove** next to the site, then reload to confirm access is restored

If you change extension files, click **Reload** on the Wardkin card in `chrome://extensions`, then test again.
