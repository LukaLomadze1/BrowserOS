/**
 * @file Start-up safety net for the one failure BrowserOS's own code
 * can't report: its code not arriving at all.
 *
 * Loaded as a small classic script just before src/main.js. If the
 * browser can't fetch src/main.js or any module it imports (a dropped
 * connection, a server error, an incomplete deployment), the module
 * script never runs, so nothing would replace the start-up screen.
 * Browsers then fire an "error" event at the module's <script> element;
 * this script listens for it and turns the start-up screen into a
 * message with a Reload button.
 *
 * It must stay dependency-free and must never throw.
 */
(function watchStartupScripts() {
  function showLoadFailure() {
    try {
      if (document.body.getAttribute("data-boot-state") !== "starting") return;
      document.body.setAttribute("data-boot-state", "failed");
      var screen = document.getElementById("boot-screen");
      if (!screen) return;
      var status = screen.querySelector(".boot-screen__status");
      var track = screen.querySelector(".boot-screen__track");
      if (track) track.hidden = true;
      if (status) {
        status.textContent = "BrowserOS couldn't be loaded. Check the connection, then reload the page.";
        status.setAttribute("role", "alert");
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "os-button os-button--primary boot-screen__reload";
      button.textContent = "Reload";
      button.addEventListener("click", function () {
        window.location.reload();
      });
      screen.querySelector(".boot-screen__progress").appendChild(button);
      button.focus();
    } catch (error) {
      /* the start-up screen is already as informative as it can be */
    }
  }

  document.addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && target.tagName === "SCRIPT" && target.type === "module") showLoadFailure();
    },
    true
  );
})();
