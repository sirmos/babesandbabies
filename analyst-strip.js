// Adds a slim pink strip at the top of a Babes & Babies page that links to the Stripe Analyst.
// Add this to a page with:  <script src="analyst-strip.js"></script>  (just before </body>)
(function () {
  if (/analyst\.html$/.test(location.pathname)) return;
  try { if (sessionStorage.getItem("hideAnalystStrip")) return; } catch (e) {}

  function add() {
    var bar = document.createElement("div");
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Stripe Analyst");
    bar.style.cssText =
      "background:#e8457c;color:#fff;font:14px system-ui,Segoe UI,Arial,sans-serif;" +
      "padding:9px 40px 9px 14px;text-align:center;position:relative;z-index:9999;";

    var link = document.createElement("a");
    link.href = "analyst.html";
    link.style.cssText = "color:#fff;text-decoration:underline;font-weight:600;";
    link.textContent = "Open Stripe Analyst";

    var text = document.createElement("span");
    text.textContent = "New: see how the shop is selling, ask questions, and test prices. ";

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Hide this strip");
    close.textContent = "x";
    close.style.cssText =
      "position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;" +
      "border:0;color:#fff;font-size:16px;cursor:pointer;line-height:1;";
    close.onclick = function () {
      bar.remove();
      try { sessionStorage.setItem("hideAnalystStrip", "1"); } catch (e) {}
    };

    bar.appendChild(text);
    bar.appendChild(link);
    bar.appendChild(close);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.body) add();
  else document.addEventListener("DOMContentLoaded", add);
})();
