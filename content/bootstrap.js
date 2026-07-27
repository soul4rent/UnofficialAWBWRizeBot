/**
 * Content script. Runs in the isolated world, where AWBW's game state is
 * invisible, so its only job is to inject the real bundle into the page world.
 *
 * game.php declares its state with top-level `let`/`const` in a classic script.
 * Those bindings live in the global lexical environment and never become
 * properties of `window`, which means a content script cannot see them even
 * through `wrappedJSObject`. Injecting a <script> tag is what gets us into the
 * same scope. Same approach as awbw_enhancements
 * (content_scripts/moveplanner_plus_script.js:774).
 */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  function injectScript(path) {
    const script = document.createElement("script");
    script.src = api.runtime.getURL(path);
    script.async = false;
    script.addEventListener("load", () => script.remove());
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript("page/bot.js");
})();
