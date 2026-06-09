/* ============================================================
   NEWNFL — landing page interactions
   Vanilla JS, no dependencies.
   ============================================================ */
(function () {
  "use strict";

  // Current year in footer
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---- Animate the score on first scroll into view ---- */
  var scoreEl = document.getElementById("scoreValue");
  if (scoreEl && "IntersectionObserver" in window) {
    var target = parseFloat(scoreEl.textContent) || 0;
    var played = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !played) {
          played = true;
          countUp(scoreEl, target, 900);
          io.disconnect();
        }
      });
    }, { threshold: 0.5 });
    io.observe(scoreEl);
  }

  function countUp(el, to, duration) {
    var start = performance.now();
    var sign = to >= 0 ? "+" : "";
    function frame(now) {
      var t = Math.min((now - start) / duration, 1);
      var eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      el.textContent = sign + (to * eased).toFixed(1);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---- Email capture (front-end only; wire to a backend later) ---- */
  var form = document.getElementById("accessForm");
  var input = document.getElementById("emailInput");
  var note = document.getElementById("formNote");

  if (form && input && note) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = input.value.trim();
      var valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!valid) {
        note.textContent = "Please enter a valid email address.";
        note.classList.add("error");
        input.focus();
        return;
      }

      note.classList.remove("error");
      note.textContent = "You're on the list — we'll be in touch as access opens.";
      form.reset();

      // Persist locally so a refresh doesn't lose intent.
      try {
        var list = JSON.parse(localStorage.getItem("newnfl_waitlist") || "[]");
        if (list.indexOf(email) === -1) list.push(email);
        localStorage.setItem("newnfl_waitlist", JSON.stringify(list));
      } catch (err) { /* storage unavailable — non-fatal */ }
    });
  }
})();
