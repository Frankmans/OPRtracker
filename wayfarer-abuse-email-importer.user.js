// ==UserScript==
// @name         Wayfarer Map Mods - Abuse Email Importer
// @namespace    https://wayfarer.scopely.com/new
// @version      4.7.2
// @description  Imports Niantic Support "Reporting Abuse in Wayfarer" tickets from Gmail via OAuth, or from .eml files -- using a port of bilde2910/OPR-Tools' email parser -- and stores them for the Abuse Report Extractor script (and other consumers) to search.
// @author       you
// @match        https://wayfarer.scopely.com/new/mapview*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      gmail.googleapis.com
// @connect      accounts.google.com
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wst-storage.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-email-importer.user.js
// ==/UserScript==

/*
 * v4.7.2 CHANGE FROM v4.7.1: renamed to "Wayfarer Map Mods - Abuse Email
 * Importer" (@name, modal title, Plugin Manager listing, console log
 * prefixes) -- see wae.js's own v1.24.1 changelog note for the fuller
 * explanation of what did and didn't change and why (same reasoning
 * applies here: @downloadURL/@updateURL/@require and internal identifiers
 * are untouched, only user-visible display strings).
 *
 * v4.7.0 CHANGE FROM v4.6.1: same underlying change as the Abuse Report
 * Extractor script's own v1.22.0 -- see that file's changelog note for the
 * fuller explanation. Short version: buildPanel()'s hand-rolled backdrop/
 * dialog (an innerHTML string styled by copying the suite's own
 * .wfmapmods-modal-* class names) is gone, replaced with a real
 * WFMM.ui.openModal() call, with the body built via WFMM.ui.createElement/
 * section/button/buttonRow/textInput/checkboxRow/selectInput. openPanel()/
 * closePanel()/togglePanel() now work through the modalController
 * openModal() returns instead of toggling a hidden panel's display style
 * -- since openModal() tears the dialog down on close rather than hiding
 * it, this panel's live DOM refs are only valid while it's open, tracked
 * via a single weiUI object set in buildContent() and cleared in the
 * onClose hook.
 *
 * IMPORTANT DIFFERENCE FROM THE EXTRACTOR SCRIPT: this script runs
 * sandboxed (@grant GM_xmlhttpRequest -- see the v4.6.1 note further down
 * on why window.WFMM isn't reachable as a bare global from in here), so
 * every WFMM.ui.* call in this file goes through wfmmWindow.WFMM.ui, never
 * a bare WFMM/window.WFMM. wfmmWindow itself moved up to the top of the
 * file (it used to only be declared right before the Plugin Manager
 * registration code at the bottom) so the same reference covers both that
 * registration bootstrap AND every UI call in the panel.
 *
 * Only the panel-*building* code changed here -- Gmail OAuth/sync, the
 * .eml import path, auto-sync, and the backup/restore JSON export are all
 * untouched, since none of that is UI-service surface.
 *
 * Companion to wayfarer-abuse-report-extractor.user.js. This script's ONLY
 * job is getting your raw emails into the shared IndexedDB store
 * ("wst_email_store", see wst-storage.js) as parsed-but-unclassified
 * records -- headers + body, nothing more. It does NOT try to figure out
 * what kind of email something is or extract a Wayspot name/coordinates
 * from it -- that's the extractor script's job.
 *
 * TWO WAYS IN:
 *   1. Connect Gmail -- OAuth (read-only) + the Gmail API, fetches matching
 *      messages directly. No manual export step, incremental after the
 *      first sync. Needs a one-time Google Cloud OAuth Client ID -- see the
 *      setup steps you were given alongside this script.
 *   2. Drop .eml files -- unchanged from before, useful as a fallback (a
 *      work computer where you can't/won't set up OAuth, a handful of
 *      one-off messages, etc).
 *
 * v3 CHANGE FROM v2: @grant went from "none" to "GM_xmlhttpRequest" so the
 * Gmail API calls run through Tampermonkey's own request machinery instead
 * of the page's fetch() -- that sidesteps Wayfarer's page CSP, which would
 * otherwise likely block a page-context request to googleapis.com. This
 * shouldn't change anything about the .eml/backup features below; @require'd
 * scripts and this script still share one execution context either way.
 *
 * v4.6.1 CHANGE FROM v4.6.0: fixed Plugin Manager registration silently
 * never happening at all -- reported symptom: the script works completely
 * normally (settings link, panel, everything) but the suite's own Plugin
 * Manager screen says "No external plugins have registered with WFMM".
 * Root cause: this script's @grant GM_xmlhttpRequest (needed for the
 * Gmail sync calls) puts it in Tampermonkey's sandboxed execution mode,
 * where this script's own `window` is a SEPARATE object from the real
 * page window -- so window.WFMM (assigned by the suite onto the real
 * page window) was always invisible here. registerOrSelfStart()'s 5s
 * polling loop always timed out and fell back to self-starting, which is
 * exactly why everything still worked -- just never through the Plugin
 * Manager. Fixed by reading through unsafeWindow instead of window.
 * Per Tampermonkey's own docs, unsafeWindow needs its OWN explicit
 * @grant entry alongside other grants (unlike @grant none, where window
 * already IS unsafeWindow with nothing extra needed) -- added @grant
 * unsafeWindow to this script's header, without which the unsafeWindow
 * fallback would have silently resolved to undefined and fallen straight
 * back to the same broken sandboxed window.
 *
 * Caveat: this is a real userscript-manager sandboxing behavior that
 * can't be reproduced in a Node/jsdom test harness -- there's no actual
 * GM sandbox to simulate. This fix is grounded in Tampermonkey's own
 * documented @grant/unsafeWindow behavior and the specific symptom
 * reported, not something verified end-to-end the way other fixes in
 * this file have been. Worth confirming directly against the real Plugin
 * Manager screen after updating.
 *
 * v4.6.0 CHANGE FROM v4.5.1: two changes.
 *   1. The dialog had no padding at all -- confirmed .wfmapmods-modal-
 *      dialog itself provides none in the real v4.0.0 suite CSS (its own
 *      modals add it via a separate inner body wrapper class this script
 *      never adopted), so content sat flush against the edges. Added
 *      padding directly on .wei-dialog, plus overflow-y:auto so tall
 *      content scrolls within the dialog instead of being clipped by the
 *      base rule's overflow:hidden.
 *   2. Now registers as a real entry in the suite's own Plugin Manager
 *      settings screen (#wfmm-plugin-manager-modal) via its external-
 *      plugin API, window.WFMM.plugins.registerExternal() -- confirmed
 *      against the real v4.0.0 source (id/name/description/author/
 *      version/apiVersion required; source:"external", requirement:
 *      "optional" default to enabled; create() returns {start,stop} and
 *      WFMM itself calls them based on the user's toggle in that screen,
 *      not this script). See startPlugin()/stopPlugin()/
 *      registerOrSelfStart() below. stop() actually tears things down --
 *      removes the settings link and panel, stops the side-panel
 *      watcher, clears any running auto-sync timer -- rather than just
 *      hiding something, so re-enabling from that screen starts clean.
 *      Falls back to the old unconditional self-start (no Plugin Manager
 *      entry) if window.WFMM.plugins never appears within 5s, so this
 *      still works standalone against an older Base version. Verified
 *      both the registration+start+stop+restart cycle and the fallback
 *      path through a simulated DOM, not just read against the source.
 *
 * v4.5.1 CHANGE FROM v4.5.0: the auto-sync checkbox looked out of place
 * (bare browser-default appearance) after v4.5.0's .wei-checkbox swap-in
 * for the removed .wfmapmods-modal-checkbox -- that rule only set size,
 * nothing else. Added accent-color to actually match the rest of the
 * panel's blue instead of leaving it unstyled.
 *
 * v4.5.0 CHANGE FROM v4.4.0: adapted for Wayfarer's move to
 * wayfarer.scopely.com and Tntnnbltn's new consolidated
 * wayfarer-map-mods.user.js suite (v4.0.0, replacing the old separate
 * wayfarer-map-mods-base.user.js + Report Wayspots scripts this was
 * previously confirmed against). @namespace/@match updated to the new
 * domain. Verified the new suite's actual source line by line against
 * everything this script depends on:
 *   - #wfmapmods-side-panel, .wfmapmods-settings-links, and all the
 *     .wfmapmods-modal-* classes this uses for its own panel are
 *     unchanged.
 *   - The map-lookup code below (confirmed against Report Wayspots
 *     v3.15.0) is still accurate -- looksLikeGoogleMap()/
 *     extractMapFromCtxEntry()'s componentRef.map pattern and the
 *     "app-submit-wayspot-map nia-map, app-wf-base-map" selectors are
 *     byte-for-byte what the new suite's own internal map resolution
 *     uses too.
 *   - #wfmapmods-poi-bridge/#wfmapmods-submit-bridge, however, are GONE
 *     -- replaced internally with a private "component bridge"
 *     abstraction with no stable public DOM contract. isMapModsBaseActive()
 *     now checks for #wfmapmods-side-panel instead (see that function),
 *     and publishPoiToMap() is now a documented no-op with a one-time
 *     console warning rather than silently writing to a throwaway
 *     element nothing reads -- see that function's own comment. This
 *     doesn't affect real map-plotting either way; that was always the
 *     extractor script's own "Show on Map" (native markers), never this
 *     bridge.
 *   - .wfmapmods-modal-checkbox is also gone (only context-specific
 *     .wfmapmods-layers-checkbox/.wfmapmods-filters-checkbox remain,
 *     neither fitting an unrelated auto-sync toggle) -- swapped for a
 *     small self-contained .wei-checkbox rule instead.
 * NOT changed: SUPPORTED_SENDERS still filters on support@nianticlabs.com
 * -- that's Niantic Support's own email address, a separate concern from
 * which website domain Wayfarer itself is hosted at, and nothing
 * indicated it changed too. Worth confirming if abuse-report tickets
 * start arriving from a different address.
 *
 * v4.4.0 CHANGE FROM v4.3.0: SUPPORTED_SENDERS narrowed to just
 * support@nianticlabs.com. Gmail sync now only screens for Niantic
 * Support's Helpshift "Reporting Abuse in Wayfarer" ticket threads --
 * dropped the general nomination/notification senders (notices@recon.
 * nianticspatial.com, notices@wayfarer.nianticlabs.com, nominations@
 * portals.ingress.com, hello@pokemongolive.com, ingress-support@
 * nianticlabs.com, ingress-support@google.com). If you want those back for
 * a different consumer later, they're in the version history, not gone
 * from Gmail -- this only changes what this script's own sync pulls in.
 * The .eml drop path is untouched: it still accepts whatever file you
 * drop, since that's already a deliberate per-file choice, not a search.
 *
 * v4.3.0 CHANGE FROM v4.2.0: the panel is now a real modal, styled with
 * Base's own .wfmapmods-modal-* classes (backdrop, dialog, title, close
 * button, buttons) instead of the old custom fixed-position dark/monospace
 * box. Centered, white, blocks the rest of the page while open (click
 * outside the dialog, Escape, or the × all close it) -- matching every
 * other Map Mods - Base panel instead of looking like a standalone widget.
 *
 * v4.2.0 CHANGE FROM v4.1.0: dropped the @require for Tntnnbltn's
 * wayfarer-map-mods-base.user.js that v4.0.0 added. @require doesn't share
 * a running instance across scripts -- it re-fetches and re-executes the
 * whole file separately inside *each* userscript that lists it. With both
 * this script and the Abuse Report Extractor requiring it, that meant two
 * independent copies of Base running side by side on the same page, each
 * building its own "#wfmapmods-side-panel" (Base has no re-init guard
 * against a *second*, separately-required copy). Base's real companion
 * script, Report Wayspots, never @requires it either -- it's installed
 * once, standalone, and every other script just assumes exactly one copy
 * is already running and talks to it purely through the DOM contract
 * (.wfmapmods-settings-links, the two bridge elements). This script now
 * does the same: Map Mods - Base needs to be installed separately for the
 * "Import Abuse Report Emails" link and publishPoiToMap() to have
 * anywhere to go, but this script no longer bundles a copy of it in.
 *
 * v4.1.0 CHANGE FROM v4.0.0: this no longer has its own floating "Import
 * Emails" button. Same move the Abuse Report Extractor script made in its
 * own v1.1.0 -- the panel now opens via an "Import Abuse Report Emails"
 * link injected into Map Mods - Base's side panel settings section
 * (".wfmapmods-settings-links"), found the same debounced-MutationObserver
 * way. The panel itself (Gmail connect, .eml dropzone, backup/maintenance)
 * is unchanged -- only how it's opened changed, plus the existing Close
 * button is now the only way to dismiss it since there's no toggle button
 * to click a second time.
 *
 * v4 CHANGES FROM v3:
 *   - support@nianticlabs.com added to SUPPORTED_SENDERS, so Gmail sync now
 *     also picks up Niantic Support's Helpshift ticket threads (e.g.
 *     "Reporting Abuse in Wayfarer"), not just the templated per-submission
 *     notification emails. Requires the updated opr-email-lib.js that knows
 *     how to classify ABUSE_REPORT_* / Style.SUPPORT emails -- @require
 *     still points at the same URL, so just make sure that file itself has
 *     been updated. Records are stored exactly as before (raw headers +
 *     body, still deliberately unclassified) -- a separate plugin is
 *     expected to call OPREmail.classify() / OPREmail.helpshift.* on them
 *     later to pull out the reported name/coordinates. This script only
 *     uses classify() itself, transiently, to add a per-import count of how
 *     many abuse-report messages came in -- that count is never stored.
 *   - @namespace changed to https://wayfarer.nianticlabs.com/new and a
 *     @require for Tntnnbltn's wayfarer-map-mods-base.user.js was added, at
 *     your request, to integrate with that base plugin.
 *     *** INTEGRATION, NOW CONFIRMED AGAINST v3.15.0 ***: there's no formal
 *     "register your plugin" API -- Base doesn't expose one. What it does
 *     expose, for any userscript sharing the page, is a pair of DOM "bridge"
 *     elements it watches with a MutationObserver:
 *       #wfmapmods-poi-bridge    (attr data-payload)    -- write a POI's
 *         {guid, title, description, lat, lng, imageUrl, status, source}
 *         as JSON and Base will show/select it in its own side panel.
 *       #wfmapmods-submit-bridge (attr data-submission)  -- write
 *         {mode, source, poi:{...}, images:{...}} as JSON and Base opens
 *         its resubmission modal for it.
 *     This script has no POI/coordinate data of its own to push -- that's
 *     the "different plugin" you're building next. So what's actually wired
 *     up here (see registerWithMapModsBase() near the bottom) is: presence
 *     detection (logged, so it's obvious if Base isn't loaded), plus a
 *     small public API, window.WayfarerAbuseEmailImporter, so that next plugin
 *     doesn't have to re-derive which stored emails are abuse reports or
 *     re-implement the POI-bridge JSON contract itself -- it can call
 *     getAbuseReportRecords() to get the stored {record, email} pairs (each
 *     email already an OPREmail.Email, ready for
 *     OPREmail.helpshift.parseAbuseReportEmail(email)), then hand the title
 *     + coordinates it extracts to publishPoiToMap() to write onto Base's
 *     real bridge.
 *     *** CORRECTION, confirmed against Report Wayspots v3.3.0's real
 *     source ***: publishPoiToMap() does NOT put a pin on the map -- Base
 *     only shows/selects a bridge-sourced POI in its own side panel (see
 *     that function's own code comment). The extractor script's actual
 *     map-plotting (added in its own v1.6.0, "Show on Map") doesn't use
 *     this bridge at all -- it ports Report Wayspots' real map-lookup code
 *     and builds its own self-contained pulse-overlay layer instead, the
 *     only approach actually confirmed to draw a marker. This function and
 *     getAbuseReportRecords() are left in place as a small convenience API
 *     regardless -- still useful for a future consumer that only wants
 *     "the abuse-report emails already parsed" or "hand one POI to Base's
 *     side panel" -- just not for map-plotting.
 *
 * GMAIL OAUTH DESIGN NOTES:
 * Uses Google Identity Services' token client (a popup-based implicit OAuth
 * flow) rather than a redirect flow, specifically because it needs no
 * redirect_uri / backend of any kind -- the token comes back to this page's
 * JS directly. The access token lives in memory only (a page variable, never
 * persisted) and is re-requested each time this page is loaded; that's a
 * deliberate simplicity/security tradeoff for a personal tool, not an
 * oversight. Your Client ID (not a secret -- it's fine to store) is kept in
 * localStorage so you don't have to repaste it constantly.
 */

(function () {
  'use strict';

  // @grant GM_xmlhttpRequest (needed for the Gmail API calls) sandboxes
  // this script -- its own `window` is a SEPARATE object from the real
  // page window, so a bare `WFMM`/`window.WFMM` reference from in here
  // would resolve to nothing, or to a stale sandboxed copy, never the
  // real page's window.WFMM the suite actually assigns to. unsafeWindow
  // reaches through the sandbox to the real page window -- see the
  // v4.6.1 changelog note further up for the fuller story (and why it
  // needs its own explicit @grant unsafeWindow entry, unlike @grant none
  // where window already IS unsafeWindow). Declared once, here, and
  // reused for every wfmmWindow.WFMM.* call in this file, not just the
  // Plugin Manager registration bootstrap at the bottom.
  const wfmmWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  // Niantic Support's Helpshift ticket threads, e.g. "Reporting Abuse in
  // Wayfarer" (confirmed real From address) -- see opr-email-lib.js's
  // Style.SUPPORT / Type.ABUSE_REPORT_* for how they're classified once
  // imported. Nomination-status notification senders (notices@recon.
  // nianticspatial.com, nominations@portals.ingress.com, etc.) were
  // dropped from here in v4.4.0 -- this script now only screens for
  // abuse-report tickets, not general Wayfarer/Spatial/Ingress mail.
  const SUPPORTED_SENDERS = [
    'support@nianticlabs.com',
  ];
  const CLIENT_ID_KEY = 'wei_gmail_client_id';
  const LAST_SYNC_KEY = 'wei_gmail_last_sync_ms';
  const AUTOSYNC_ENABLED_KEY = 'wei_autosync_enabled';
  const AUTOSYNC_INTERVAL_KEY = 'wei_autosync_interval_min';
  const CONCURRENCY = 5;

  // Only what WFMM.ui's own base styles (injected via ui.injectStyle()/
  // ui.openModal() itself) don't already cover -- the modal shell,
  // buttons, text inputs, checkboxes, selects, and section headers all
  // come from the suite's own wfmm-* classes now (WFMM.ui.createElement/
  // button/textInput/checkboxRow/selectInput/section), so there's much
  // less left to define here than the old hand-copied .wfmapmods-modal-*
  // lookalike needed. See wae.js's own v1.22.0 changelog note for the
  // fuller story -- same change, applied here.
  const STYLE = `
    #wei-panel .wfmapmods-modal-dialog{ width:480px; max-width:calc(100vw - 24px); }
    .wei-sub{ font-size:11px; color:var(--wfmm-muted-text, #667085); margin-bottom:8px; }
    #wei-dropzone{
      border:2px dashed #d1d5db; border-radius:6px; padding:20px 10px; text-align:center;
      color:#6b7280; margin:6px 0; cursor:pointer; font-size:12px;
    }
    #wei-dropzone.drag{ border-color:#2563eb; color:#2563eb; }
    .wei-autosync-row{ display:flex; align-items:center; gap:6px; font-size:12px; color:#374151; margin:6px 0; cursor:default; }
    .wei-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    .wei-log{
      margin-top:8px; max-height:180px; overflow-y:auto; font-size:11px; line-height:1.5;
    }
    .wei-log div.ok{ color:#16a34a; }
    .wei-log div.skip{ color:#6b7280; }
    .wei-log div.err{ color:#dc2626; }
  `;

  // ---------------------------------------------------------------------
  // Gmail OAuth + API helpers
  // ---------------------------------------------------------------------

  let accessToken = null;
  let tokenExpiryMs = 0;
  let tokenClient = null;
  let autoSyncTimer = null;
  let autoSyncInProgress = false;

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(
        'Could not load Google\u2019s sign-in script. If this keeps happening, Wayfarer\u2019s ' +
        'page security policy may be blocking accounts.google.com from loading here.'
      ));
      document.head.appendChild(s);
    });
  }

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message || 'Timed out')), ms)),
    ]);
  }

  function requestAccessToken(clientId, interactive) {
    return new Promise((resolve, reject) => {
      loadGis().then(() => {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: GMAIL_SCOPE,
          callback: (resp) => {
            if (resp.error) { reject(new Error(resp.error)); return; }
            accessToken = resp.access_token;
            tokenExpiryMs = Date.now() + (resp.expires_in * 1000) - 60000;
            resolve(accessToken);
          },
        });
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      }).catch(reject);
    });
  }

  // forceNonInteractive is used by background auto-sync ticks -- a timer
  // callback is never a "user gesture", so browsers will block any popup
  // it tries to open. A non-interactive (prompt: '') request either
  // silently renews via an existing Google session with no visible popup,
  // or fails -- it never falls back to an interactive popup on its own.
  async function getValidToken(clientId, opts) {
    const forceNonInteractive = !!(opts && opts.forceNonInteractive);
    if (accessToken && Date.now() < tokenExpiryMs) return accessToken;
    const interactive = forceNonInteractive ? false : !accessToken;
    const request = requestAccessToken(clientId, interactive);
    // Silent renewal can hang indefinitely (rather than reject) if
    // third-party cookies are blocked -- only relevant for the
    // non-interactive path, since the interactive path legitimately waits
    // on the user to finish a popup.
    return forceNonInteractive ? withTimeout(request, 10000, 'Silent token refresh timed out') : request;
  }

  function gmApiGet(url, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${token}` },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('Gmail API returned something that wasn\u2019t valid JSON')); }
          } else if (res.status === 401) {
            reject(Object.assign(new Error('Gmail token expired or was revoked'), { authExpired: true }));
          } else {
            reject(new Error(`Gmail API error ${res.status}: ${res.responseText.slice(0, 300)}`));
          }
        },
        onerror: () => reject(new Error('Network error calling the Gmail API')),
      });
    });
  }

  function buildGmailQuery(lastSyncMs) {
    const senderClause = '(' + SUPPORTED_SENDERS.map((s) => `from:${s}`).join(' OR ') + ')';
    if (!lastSyncMs) return senderClause;
    // 1-day safety buffer -- same as gmail_wayspot_export.py's incremental
    // sync, since Gmail's after: operator only has day granularity.
    const buffered = new Date(lastSyncMs - 24 * 60 * 60 * 1000);
    const y = buffered.getUTCFullYear();
    const m = String(buffered.getUTCMonth() + 1).padStart(2, '0');
    const d = String(buffered.getUTCDate()).padStart(2, '0');
    return `${senderClause} after:${y}/${m}/${d}`;
  }

  function base64UrlToText(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function listAllMessageIds(query, token, onProgress) {
    const ids = [];
    let pageToken = null;
    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await gmApiGet(url.toString(), token);
      for (const m of (page.messages || [])) ids.push(m.id);
      pageToken = page.nextPageToken || null;
      if (onProgress) onProgress(ids.length);
    } while (pageToken);
    return ids;
  }

  // Bounded-concurrency fetch of each message's raw RFC822 content.
  async function fetchMessagesRaw(ids, token, onProgress) {
    const results = new Array(ids.length);
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < ids.length) {
        const i = cursor++;
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ids[i]}?format=raw`;
        try {
          const msg = await gmApiGet(url, token);
          results[i] = { id: ids[i], raw: msg.raw, error: null };
        } catch (e) {
          results[i] = { id: ids[i], raw: null, error: e };
        }
        done++;
        if (onProgress) onProgress(done, ids.length);
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  function loadAutoSyncSettings() {
    return {
      enabled: localStorage.getItem(AUTOSYNC_ENABLED_KEY) === 'true',
      intervalMin: Number(localStorage.getItem(AUTOSYNC_INTERVAL_KEY)) || 15,
    };
  }
  function saveAutoSyncSettings(enabled, intervalMin) {
    localStorage.setItem(AUTOSYNC_ENABLED_KEY, String(enabled));
    localStorage.setItem(AUTOSYNC_INTERVAL_KEY, String(intervalMin));
  }

  // WFMM.ui, set while the panel is open, and the currently-open panel's
  // live DOM refs -- same pattern as the extractor script's own waeUiApi/
  // waeUI (see its v1.22.0 changelog note). Both null while the panel is
  // closed, since WFMM.ui.openModal() tears the dialog down on close
  // instead of just hiding it, the way the old backdrop did.
  let weiUiApi = null;
  let weiUI = null;
  let weiPanelController = null;

  // Auto-sync keeps running in the background whether or not the panel is
  // open (that was already true before this refactor -- the old backdrop
  // just stayed in the DOM hidden). Logging and progress text now have to
  // tolerate the panel being closed: weiLog() below buffers into
  // weiPendingLog (oldest-first, capped) when there's no logEl to write
  // into, and flushes it into the fresh logEl next time the panel opens,
  // so nothing a background tick logged gets silently lost.
  let weiPendingLog = [];

  function weiLog(msg, cls) {
    if (weiUI) {
      weiUI.logEl.prepend(weiUiApi.createElement('div', { className: cls || '', text: msg }));
      while (weiUI.logEl.children.length > 200) weiUI.logEl.removeChild(weiUI.logEl.lastChild);
      return;
    }
    weiPendingLog.push({ msg, cls });
    if (weiPendingLog.length > 50) weiPendingLog.shift();
  }

  function weiSetProgress(text) {
    if (weiUI) weiUI.progressEl.textContent = text;
  }

  async function refreshCount() {
    if (!weiUI) return;
    try {
      const n = await WSTStorage.countEmails();
      weiUI.countEl.textContent = `${n} email(s) stored. Open the Abuse Report Extractor to scan them.`;
    } catch (e) {
      weiUI.countEl.textContent = 'Could not read the email store.';
    }
  }

  function updateGmailStatus() {
    if (!weiUI) return;
    const lastSync = localStorage.getItem(LAST_SYNC_KEY);
    const auto = loadAutoSyncSettings();
    const autoSuffix = auto.enabled ? ` Auto-sync: every ${auto.intervalMin} min.` : '';
    if (accessToken) {
      weiUI.gmailStatusEl.textContent = (lastSync
        ? `Connected. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
        : 'Connected. Never synced yet.') + autoSuffix;
    } else {
      weiUI.gmailStatusEl.textContent = (lastSync
        ? `Not connected this session. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
        : 'Not connected.') + autoSuffix;
    }
  }

  // ---- .eml import (unchanged from v2) ----

  function normalizeEml(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }

  function emlToRecord(text, fallbackName) {
    const email = OPREmail.parseMIME(normalizeEml(text));
    const messageId = email.getFirstHeaderValue('Message-ID', null);
    const id = messageId || `synthetic:${fallbackName}:${text.length}`;
    return { id, filename: fallbackName, ts: Date.now(), headers: email.headers, body: email.body };
  }

  // Transient-only: used to add an "N abuse report ticket(s)" count to the
  // import log line. Never persisted -- stored records stay the
  // deliberately-unclassified {headers, body} shape described up top, so
  // the extractor script re-classifies from the raw email itself, the
  // same way this helper does.
  function isAbuseReportRecord(record) {
    try {
      // record.headers/body are already the decoded {name, value} pairs
      // and raw body that emlToRecord() stored, in exactly the shape
      // OPREmail.Email's constructor expects -- no need to re-serialize
      // and re-parse the whole MIME message just to classify it.
      const email = new OPREmail.Email(record.headers, record.body);
      const { type } = email.classify();
      return typeof type === 'string' && type.startsWith('ABUSE_REPORT_');
    } catch (e) {
      return false;
    }
  }

  function countAbuseReports(records) {
    return records.reduce((n, r) => n + (isAbuseReportRecord(r) ? 1 : 0), 0);
  }

  async function importFiles(files) {
    const records = [];
    let parseErrors = 0;
    for (const file of files) {
      let text;
      try {
        text = await file.text();
      } catch (e) {
        weiLog(`✗ ${file.name}: could not read file`, 'err');
        parseErrors++;
        continue;
      }
      try {
        records.push(emlToRecord(text, file.name));
      } catch (e) {
        weiLog(`✗ ${file.name}: ${e.message || e}`, 'err');
        parseErrors++;
      }
    }

    if (records.length) {
      const { inserted, updated } = await WSTStorage.putEmails(records);
      const abuseCount = countAbuseReports(records);
      const abuseSuffix = abuseCount ? `, ${abuseCount} abuse report ticket${abuseCount === 1 ? '' : 's'}` : '';
      weiLog(`✓ Imported ${records.length} file(s): ${inserted} new, ${updated} updated${abuseSuffix}`, 'ok');
    }
    if (parseErrors) weiLog(`${parseErrors} file(s) could not be parsed as MIME email`, 'err');
    await refreshCount();
  }

  // ---- Gmail sync ----
  //
  // Moved to module scope (used to live inside buildPanel(), closed over
  // that one persistent panel's elements). Now reads the OAuth Client ID
  // from localStorage directly rather than a live input -- this needs to
  // keep working from a background auto-sync tick even while the panel is
  // closed and no such input exists. weiSetProgress()/weiUI-guarded button
  // toggling below are no-ops in that case; see weiLog()'s comment above
  // for the same reasoning applied to logging.
  async function runSync(forceFull, opts) {
    const auto = !!(opts && opts.auto);
    const clientId = (localStorage.getItem(CLIENT_ID_KEY) || '').trim();
    if (!clientId) {
      if (!auto) weiLog('Paste your OAuth Client ID first', 'err');
      return;
    }

    if (weiUI) { weiUI.syncBtn.disabled = true; weiUI.fullResyncBtn.disabled = true; }
    weiSetProgress(auto ? 'Auto-sync: connecting to Gmail\u2026' : 'Connecting to Gmail\u2026');

    const lastSyncMs = forceFull ? null : Number(localStorage.getItem(LAST_SYNC_KEY)) || null;
    const syncStartedAt = Date.now();

    try {
      let token;
      try {
        token = await getValidToken(clientId, { forceNonInteractive: auto });
      } catch (e) {
        if (auto) {
          weiLog('Auto-sync skipped this round: Gmail sign-in needed -- click "Sync new emails" once to reconnect', 'skip');
          return;
        }
        throw e;
      }
      updateGmailStatus();

      const query = buildGmailQuery(lastSyncMs);
      weiSetProgress('Listing matching messages\u2026');
      const ids = await listAllMessageIds(query, token, (n) => {
        weiSetProgress(`Found ${n} matching message(s) so far\u2026`);
      });

      if (ids.length === 0) {
        weiLog(auto ? 'Auto-sync: no new messages found' : 'No new messages found', 'skip');
        localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
        updateGmailStatus();
        return;
      }

      weiSetProgress(`Fetching ${ids.length} message(s)\u2026`);
      const raws = await fetchMessagesRaw(ids, token, (done, total) => {
        weiSetProgress(`Fetching messages\u2026 ${done}/${total}`);
      });

      const records = [];
      let fetchErrors = 0, parseErrors = 0;
      for (const r of raws) {
        if (r.error) {
          fetchErrors++;
          if (r.error.authExpired) weiLog('Gmail token expired mid-sync -- run Sync again to resume', 'err');
          continue;
        }
        try {
          const text = base64UrlToText(r.raw);
          records.push(emlToRecord(text, `gmail:${r.id}`));
        } catch (e) {
          parseErrors++;
        }
      }

      if (records.length) {
        const { inserted, updated } = await WSTStorage.putEmails(records);
        const abuseCount = countAbuseReports(records);
        const abuseSuffix = abuseCount ? `, ${abuseCount} abuse report ticket${abuseCount === 1 ? '' : 's'}` : '';
        weiLog(`✓ ${auto ? 'Auto-sync: synced' : 'Synced'} ${records.length} message(s) from Gmail: ${inserted} new, ${updated} updated${abuseSuffix}`, 'ok');
      }
      if (fetchErrors) weiLog(`${fetchErrors} message(s) failed to fetch (see above)`, 'err');
      if (parseErrors) weiLog(`${parseErrors} message(s) could not be parsed as MIME email`, 'err');

      localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
    } catch (e) {
      weiLog(`${auto ? 'Auto-sync failed: ' : 'Gmail sync failed: '}${e.message || e}`, 'err');
    } finally {
      weiSetProgress('');
      if (weiUI) { weiUI.syncBtn.disabled = false; weiUI.fullResyncBtn.disabled = false; }
      updateGmailStatus();
      await refreshCount();
    }
  }

  // ---- Auto-sync ----
  // Also moved to module scope -- this has to keep ticking for the page's
  // lifetime regardless of whether the panel is currently mounted.

  function stopAutoSync() {
    if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  }

  async function runAutoSyncTick() {
    if (autoSyncInProgress) return; // don't overlap with an in-flight sync
    autoSyncInProgress = true;
    try {
      await runSync(false, { auto: true });
    } finally {
      autoSyncInProgress = false;
    }
  }

  function startAutoSync(intervalMin) {
    stopAutoSync();
    autoSyncTimer = setInterval(runAutoSyncTick, intervalMin * 60 * 1000);
  }

  // Builds the panel's BODY content into an already-open WFMM.ui modal --
  // called as openModal()'s buildContent(modalController). See wae.js's
  // own buildPanelContent() for the fuller explanation of this pattern;
  // same shape here.
  function buildPanelContent(modal) {
    const ui = modal.ui;
    weiUiApi = ui;

    const countEl = ui.createElement('div', { className: 'wei-sub', text: 'Loading...' });

    // -- Connect Gmail --
    const clientIdInput = ui.textInput({
      className: 'wfmm-input wfmm-input-large',
      placeholder: 'OAuth Client ID (ends in .apps.googleusercontent.com)',
      value: localStorage.getItem(CLIENT_ID_KEY) || '',
    });
    clientIdInput.addEventListener('change', () => {
      localStorage.setItem(CLIENT_ID_KEY, clientIdInput.value.trim());
    });

    const gmailStatusEl = ui.createElement('div', { className: 'wei-sub', text: 'Not connected.' });
    const progressEl = ui.createElement('div', { className: 'wei-progress' });

    const syncBtn = ui.button({
      text: 'Sync new emails',
      variant: 'primary',
      onClick: () => runSync(false),
    });
    const fullResyncBtn = ui.button({
      text: 'Force full re-sync',
      onClick: () => {
        if (confirm('Re-fetch your entire matching mailbox history from Gmail, not just what\u2019s new since last sync?')) {
          runSync(true);
        }
      },
    });
    const syncBtnRow = ui.buttonRow([syncBtn, fullResyncBtn]);

    const savedAutoSync = loadAutoSyncSettings();
    const autoSyncInterval = ui.selectInput({
      options: [
        { value: '5', label: '5 min' },
        { value: '15', label: '15 min' },
        { value: '30', label: '30 min' },
        { value: '60', label: '60 min' },
      ],
      value: String(savedAutoSync.intervalMin),
      onChange: (value) => {
        const intervalMin = Number(value);
        saveAutoSyncSettings(autoSyncToggle.input.checked, intervalMin);
        if (autoSyncToggle.input.checked) startAutoSync(intervalMin);
      },
    });
    const autoSyncToggle = ui.checkboxRow({
      label: 'Auto-sync every',
      checked: savedAutoSync.enabled,
      onChange: (checked) => {
        const intervalMin = Number(autoSyncInterval.value);
        saveAutoSyncSettings(checked, intervalMin);
        if (checked) {
          // This click IS a direct user gesture, so an interactive consent
          // popup is allowed here if needed -- establishes the session that
          // subsequent silent background ticks can then reuse.
          runSync(false, { auto: false });
          startAutoSync(intervalMin);
          weiLog(`Auto-sync enabled -- syncing every ${intervalMin} minute(s)`, 'ok');
        } else {
          stopAutoSync();
          weiLog('Auto-sync disabled', 'skip');
        }
      },
    });
    // checkboxRow()'s own label only covers "Auto-sync every" -- the
    // interval select belongs in the same row, after it.
    autoSyncToggle.row.appendChild(autoSyncInterval);

    const gmailSection = ui.section({
      title: 'Connect Gmail',
      children: [clientIdInput, gmailStatusEl, progressEl, syncBtnRow, autoSyncToggle.row],
    });

    // -- Or drop .eml files --
    const dropzone = ui.createElement('div', { id: 'wei-dropzone', text: 'Drop .eml files here, or click to choose' });
    const fileInput = ui.createElement('input', {
      attrs: { type: 'file', accept: '.eml', multiple: true },
      style: { display: 'none' },
    });
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.eml'));
      if (files.length) importFiles(files);
      else weiLog('No .eml files found in the drop', 'skip');
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      fileInput.value = '';
      if (files.length) importFiles(files);
    });
    const emlSection = ui.section({
      title: 'Or drop .eml files',
      children: [dropzone, fileInput],
    });

    // -- Backup / maintenance --
    const exportBtn = ui.button({
      text: 'Export backup JSON',
      onClick: async () => {
        const all = await WSTStorage.getAllEmails();
        const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), emails: all })], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `wst-email-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        weiLog(`Exported ${all.length} email(s) to a backup file`, 'ok');
      },
    });
    const backupInput = ui.createElement('input', {
      attrs: { type: 'file', accept: '.json,application/json' },
      style: { display: 'none' },
    });
    const importBackupBtn = ui.button({ text: 'Import backup JSON', onClick: () => backupInput.click() });
    backupInput.addEventListener('change', async () => {
      const file = backupInput.files[0];
      backupInput.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const emails = Array.isArray(parsed) ? parsed : parsed.emails;
        if (!Array.isArray(emails)) { weiLog('That file doesn\u2019t look like a valid backup', 'err'); return; }
        const { inserted, updated } = await WSTStorage.putEmails(emails);
        weiLog(`✓ Restored backup: ${inserted} new, ${updated} updated`, 'ok');
        await refreshCount();
      } catch (e) {
        weiLog(`Could not read that backup file: ${e.message || e}`, 'err');
      }
    });
    const clearBtn = ui.button({
      text: 'Clear all stored emails',
      variant: 'danger',
      onClick: async () => {
        if (!confirm('Delete every stored email from this browser? This cannot be undone (export a backup first if unsure).')) return;
        await WSTStorage.clearAll();
        weiLog('All stored emails cleared', 'skip');
        await refreshCount();
      },
    });
    const backupBtnRow = ui.buttonRow([exportBtn, importBackupBtn, clearBtn]);
    const logEl = ui.createElement('div', { className: 'wei-log' });
    const backupSection = ui.section({
      title: 'Backup / maintenance',
      noBorder: true,
      children: [backupBtnRow, backupInput, logEl],
    });

    modal.body.append(countEl, gmailSection, emlSection, backupSection);

    weiUI = { countEl, gmailStatusEl, progressEl, syncBtn, fullResyncBtn, logEl };

    // Flush anything logged while the panel was closed (a background
    // auto-sync tick, most likely) -- see weiLog()'s comment above.
    for (const entry of weiPendingLog) {
      logEl.prepend(ui.createElement('div', { className: entry.cls || '', text: entry.msg }));
    }
    weiPendingLog = [];

    refreshCount();
    updateGmailStatus();

    return {
      onClose() {
        weiUI = null;
        weiPanelController = null;
      },
    };
  }

  function openPanel() {
    if (weiPanelController) return; // already open
    weiPanelController = wfmmWindow.WFMM.ui.openModal({
      id: 'wei-panel',
      title: 'Wayfarer Map Mods - Abuse Email Importer',
      className: 'wei-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      // See wae.js's own openPanel() comment -- same story here.
      // Draggable/resizable already work automatically through
      // openModal() once the user turns on "Make modals draggable"/"Make
      // modals resizeable" in Base's Side Panel settings; a plugin can't
      // force it on for just its own modal. minWidth/minHeight only
      // matter once resizing is on.
      desktopInteractions: { minWidth: 360, minHeight: 280 },
      buildContent: buildPanelContent,
    });
  }

  function closePanel() {
    weiPanelController?.close();
  }

  function togglePanel() {
    if (weiPanelController) closePanel();
    else openPanel();
  }

  // ---------------------------------------------------------------------
  // Map Mods - Base integration -- confirmed against the real base script
  // (v3.15.0) you shared. See the v4 CHANGES note at the top for the full
  // explanation; short version: Base has no formal plugin-registration
  // hook, just two DOM "bridge" elements it watches with a
  // MutationObserver. This script doesn't have POI/coordinate data of its
  // own to push, so it exposes a small public API for the future
  // extraction plugin to use instead of re-deriving/reimplementing this.
  // ---------------------------------------------------------------------
  function isMapModsBaseActive() {
    // v4.0.0 of the consolidated wayfarer-map-mods.user.js suite removed
    // the #wfmapmods-poi-bridge/#wfmapmods-submit-bridge DOM elements this
    // used to check for entirely (confirmed against its real source --
    // zero matches for either id; replaced internally with a private
    // "component bridge" abstraction that isn't exposed via any stable
    // public DOM contract). #wfmapmods-side-panel is still created the
    // same way, so that's the reliable "is Base loaded and running here"
    // signal now -- the same element this script's own settings-link
    // watcher already depends on.
    return !!document.getElementById('wfmapmods-side-panel');
  }

  let poiBridgeWarned = false;

  // Writes a POI onto Map Mods - Base's POI bridge -- the exact payload
  // shape its old handleBridgePoiPayload() read (confirmed against
  // v3.15.0). That bridge no longer exists as of v4.0.0 of the
  // consolidated suite (see isMapModsBaseActive() above) -- this is now a
  // documented no-op rather than silently writing to a throwaway element
  // nothing reads, which would give false confidence that something
  // happened. Kept in place (not removed, not throwing) since it's part
  // of window.WayfarerAbuseEmailImporter's public API and some external
  // caller may still invoke it; warns once, not on every call. Base
  // shows/selects a bridge-sourced POI in its own side panel when the
  // bridge existed -- it never dropped a map marker for one regardless.
  // The extractor script's own "Show on Map" (native google.maps.Marker,
  // not this bridge) is the actual working map-plotting mechanism.
  function publishPoiToMap({ guid, title, description, lat, lng, imageUrl, status, source } = {}) {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('publishPoiToMap: lat/lng must be finite numbers');
    }
    if (!poiBridgeWarned) {
      poiBridgeWarned = true;
      console.warn('[Wayfarer Map Mods - Abuse Email Importer] publishPoiToMap() is a no-op: Map Mods - Base v4.0.0 removed the POI bridge this used to write to. Use the Abuse Report Extractor\'s own "Show on Map" instead.');
    }
  }

  // For the future extraction plugin: every currently-stored email that
  // classifies as an abuse-report ticket, already reconstructed as an
  // OPREmail.Email (so classify()/getBody()/etc. are all available without
  // re-fetching from storage or re-parsing headers by hand).
  async function getAbuseReportRecords() {
    const all = await WSTStorage.getAllEmails();
    const out = [];
    for (const record of all) {
      try {
        const email = new OPREmail.Email(record.headers, record.body);
        const { type } = email.classify();
        if (typeof type === 'string' && type.startsWith('ABUSE_REPORT_')) {
          out.push({ record, email });
        }
      } catch (e) {
        // Skip anything that doesn't parse/classify; not this function's
        // job to surface parse errors, callers can inspect the record
        // directly if they need to know why one was skipped.
      }
    }
    return out;
  }

  window.WayfarerAbuseEmailImporter = {
    getAbuseReportRecords,
    publishPoiToMap,
    isMapModsBaseActive,
  };

  function registerWithMapModsBase() {
    if (isMapModsBaseActive()) {
      console.info('[Wayfarer Map Mods - Abuse Email Importer] Map Mods - Base detected -- window.WayfarerAbuseEmailImporter is available.');
    } else {
      // Not necessarily an error -- Base uses @run-at document-start and
      // we're document-idle, so this is usually just "hasn't run yet".
      // Re-check once after a beat rather than only logging a possibly-
      // stale negative result.
      setTimeout(() => {
        console.info(
          isMapModsBaseActive()
            ? '[Wayfarer Map Mods - Abuse Email Importer] Map Mods - Base detected -- window.WayfarerAbuseEmailImporter is available.'
            : '[Wayfarer Map Mods - Abuse Email Importer] Map Mods - Base not detected on this page. window.WayfarerAbuseEmailImporter is still available, but publishPoiToMap() will have nothing to show until Base loads.'
        );
      }, 2000);
    }
  }

  // ---------------------------------------------------------------------
  // Map Mods - Base side panel integration -- same pattern as the Abuse
  // Report Extractor script (and Report Wayspots' real
  // insertReportingHistoryLinkIfReady()/insertReportingSettingsLinkIfReady()):
  // appendChild a plain <a> into ".wfmapmods-settings-links" the first time
  // it exists, found via a debounced MutationObserver gated on
  // "#wfmapmods-side-panel". Replaces the old standalone floating button --
  // the panel now opens from this link instead.
  // ---------------------------------------------------------------------

  const SETTINGS_LINK_ID = 'wei-settings-link';
  let sidePanelObserver = null;
  let sidePanelMutationScheduled = false;

  function insertSettingsLinkIfReady() {
    const settingsBody = document.querySelector('.wfmapmods-settings-links');
    if (!settingsBody) return false;
    if (document.getElementById(SETTINGS_LINK_ID)) return true;

    const link = document.createElement('a');
    link.id = SETTINGS_LINK_ID;
    link.textContent = 'Import Abuse Report Emails';
    link.style.cursor = 'pointer';

    settingsBody.appendChild(link);

    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      togglePanel();
    });

    return true;
  }

  function sidePanelMutationHandler() {
    if (!document.querySelector('#wfmapmods-side-panel')) return;
    if (insertSettingsLinkIfReady()) stopSidePanelWatcher();
  }

  function startSidePanelWatcher() {
    if (sidePanelObserver) return;

    sidePanelMutationHandler(); // covers the case it's already there

    sidePanelObserver = new MutationObserver(() => {
      if (sidePanelMutationScheduled) return;
      sidePanelMutationScheduled = true;
      setTimeout(() => {
        sidePanelMutationScheduled = false;
        sidePanelMutationHandler();
      }, 50);
    });

    sidePanelObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopSidePanelWatcher() {
    if (sidePanelObserver) {
      sidePanelObserver.disconnect();
      sidePanelObserver = null;
    }
  }

  function startPlugin() {
    registerWithMapModsBase();
    // Registering as an external plugin already implies WFMM.ui exists --
    // see wae.js's own startPlugin() comment for why. injectStyle() is
    // idempotent (replaces by id), safe to call on every startPlugin().
    wfmmWindow.WFMM.ui.injectStyle('wei-extra-styles', STYLE);
    startSidePanelWatcher();
    // Auto-sync used to only start the first time buildPanel() ever ran
    // (which happened here too, since startPlugin() called it eagerly).
    // Now that the panel's DOM is only built on open, this has moved out
    // on its own -- auto-sync should begin as soon as the plugin starts,
    // whether or not anyone ever opens the panel.
    const savedAutoSync = loadAutoSyncSettings();
    if (savedAutoSync.enabled) startAutoSync(savedAutoSync.intervalMin);
  }

  function stopPlugin() {
    stopSidePanelWatcher();
    document.getElementById('wei-settings-link')?.remove();
    closePanel(); // no-op if the panel isn't open; openModal's own close() tears its DOM down
    stopAutoSync();
  }

  // ---------------------------------------------------------------------
  // Map Mods plugin manager registration -- v4.0.0 of the consolidated
  // suite added a real external-plugin API (confirmed against its source:
  // window.WFMM.plugins.registerExternal()), which makes this show up as
  // a normal entry in the suite's own Plugin Manager settings screen
  // (#wfmm-plugin-manager-modal) with a name/description/enable-toggle,
  // same as any of its own bundled features. WFMM calls create().start()
  // for us once registered (as part of its own startup sequence, or
  // immediately if the suite already finished starting) -- we must NOT
  // also call startPlugin() ourselves after a successful registration, or
  // it would start twice. stop() runs if the user disables it from that
  // screen.
  //
  // Falls back to the old self-starting behavior (no Plugin Manager
  // entry, just the settings-link-in-side-panel approach from earlier
  // versions) if window.WFMM.plugins never becomes available within 5s --
  // covers an older Base version, or this script's own document-idle
  // timing landing before the suite has run at all.
  // ---------------------------------------------------------------------

  const PLUGIN_ID = 'wayfarer-abuse-email-importer';
  const PLUGIN_DEFINITION = {
    id: PLUGIN_ID,
    name: (typeof GM_info !== 'undefined' && GM_info.script?.name) || 'Wayfarer Map Mods - Abuse Email Importer',
    description: 'Imports Niantic Support "Reporting Abuse in Wayfarer" tickets from Gmail or .eml files, for the Abuse Report Extractor to scan.',
    source: 'external',
    requirement: 'optional',
    author: (typeof GM_info !== 'undefined' && GM_info.script?.author) || 'unknown',
    version: (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0.0.0',
    namespace: (typeof GM_info !== 'undefined' && GM_info.script?.namespace) || undefined,
    apiVersion: 1,
    create() {
      return { start: startPlugin, stop: stopPlugin };
    },
  };

  // wfmmWindow is declared once, near the top of this file (see that
  // comment for why) -- reused here unchanged from earlier versions. This
  // is the confirmed cause of "script works standalone, but the suite's
  // Plugin Manager shows nothing under External plugins" if it's ever
  // missing: registration silently never happens, the 5s timeout below
  // always elapses, and self-start quietly takes over every time.
  function registerOrSelfStart(attemptsLeft) {
    const plugins = wfmmWindow.WFMM && wfmmWindow.WFMM.plugins;
    if (plugins && typeof plugins.registerExternal === 'function') {
      try {
        plugins.registerExternal(PLUGIN_DEFINITION);
        return; // registered -- WFMM owns calling start()/stop() from here
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Email Importer] Plugin Manager registration failed, self-starting instead:', e);
        startPlugin();
        return;
      }
    }
    if (attemptsLeft > 0) {
      setTimeout(() => registerOrSelfStart(attemptsLeft - 1), 250);
      return;
    }
    console.warn('[Wayfarer Map Mods - Abuse Email Importer] Map Mods plugin manager not detected after 5s -- self-starting instead.');
    startPlugin();
  }

  registerOrSelfStart(20); // 20 * 250ms = 5s
})();
