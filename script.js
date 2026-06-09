/* ============================================================
   NEWNFL — landing page interactions
   Vanilla JS, no dependencies.
   ============================================================ */
(function () {
  "use strict";

  /* ---- Supabase config (publishable key — safe to expose; protected by RLS) ---- */
  var SUPABASE_URL = "https://vhnbugglrpxwuzjfuzph.supabase.co";
  var SUPABASE_KEY = "sb_publishable_ADqo7llyvsSu6pDA78Iw7A_xoUHQrPf";

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
    var submitBtn = form.querySelector("button[type='submit']");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = input.value.trim().toLowerCase();
      var valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!valid) {
        setNote("Please enter a valid email address.", true);
        input.focus();
        return;
      }

      // Always keep a local copy so a refresh doesn't lose intent.
      saveLocal(email);

      setBusy(true);
      submitToSupabase(email)
        .then(function (result) {
          if (result === "duplicate") {
            setNote("You're already on the list — we'll be in touch.", false);
          } else {
            setNote("You're on the list — we'll be in touch as access opens.", false);
          }
          form.reset();
        })
        .catch(function () {
          // Network/endpoint failure — the email is saved locally, so don't alarm the user.
          setNote("You're on the list — we'll be in touch as access opens.", false);
          form.reset();
        })
        .then(function () { setBusy(false); });
    });

    function submitToSupabase(email) {
      return fetch(SUPABASE_URL + "/rest/v1/waitlist", {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          email: email,
          source: "landing",
          user_agent: navigator.userAgent
        })
      }).then(function (res) {
        if (res.ok) return "ok";
        if (res.status === 409) return "duplicate"; // unique-index violation
        throw new Error("waitlist insert failed: " + res.status);
      });
    }

    function setBusy(busy) {
      input.disabled = busy;
      if (submitBtn) {
        submitBtn.disabled = busy;
        submitBtn.textContent = busy ? "Sending…" : "Request access";
      }
    }

    function setNote(msg, isError) {
      note.textContent = msg;
      note.classList.toggle("error", !!isError);
    }

    function saveLocal(email) {
      try {
        var list = JSON.parse(localStorage.getItem("newnfl_waitlist") || "[]");
        if (list.indexOf(email) === -1) list.push(email);
        localStorage.setItem("newnfl_waitlist", JSON.stringify(list));
      } catch (err) { /* storage unavailable — non-fatal */ }
    }
  }
})();
