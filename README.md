# Wardkin

Chrome extension that blocks distracting websites and runs concentration sessions. Click the popup to add the current site to the block list; visits to blocked sites show a high-opacity grey overlay with a red “This site is blocked” message. The page stays faintly visible underneath in greyscale and cannot be scrolled or interacted with.

You can also start a concentration session for the current website (30 minutes by default). If you switch to a different site during the session, a reminder overlay asks you to return. When the session finishes, Gargou appears in a small toast at the top-right of the page.

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

### Concentration session

1. Open a website you want to focus on and click the Wardkin icon
2. Leave duration at **30** minutes (or set another length) and click **Start session**
3. Switch to a different website in another already-open tab (no reload needed) — you should see a “Stay on task” reminder with the focused site and time remaining
4. Click **Return to site** to go back, or **Continue anyway** to dismiss the reminder on that tab
5. When the timer finishes, a small Gargou toast appears at the top-right of the current page. Ending a session early from the popup skips that celebration.

If you change extension files, click **Reload** on the Wardkin card in `chrome://extensions`, then test again. You do not need to reload the websites you already have open.
