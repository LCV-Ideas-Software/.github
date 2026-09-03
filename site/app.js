/* www.lcv.dev — page engine (vanilla, sem build step) */
(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============ lcv.yaml — a empresa como código ============ */
  const K = "y-key", S = "y-str", P = "y-punc", A = "y-arrow", T = "y-tag";
  const YAML = [
    [[K, "studio"], [P, ": "], [S, "LCV Ideas & Software"]],
    [[K, "sede"], [P, ": "], [S, "São Paulo, Brasil"]],
    [[K, "site"], [P, ": "], [S, "https://www.lcv.dev"]],
    [[K, "modelo"], [P, ": "], [S, "vibe coding com portões determinísticos"]],
    [[K, "produtos"], [P, ":"]],
    [[P, "  - "], [T, "Reflexos da Alma"], [P, " "], [A, "→"], [S, " blog público + AI "], [P, "["], [T, "Live"], [P, "]"]],
    [[P, "  - "], [T, "Astrólogo"], [P, " "], [A, "→"], [S, " mapas astrais + AI "], [P, "["], [T, "Live"], [P, "]"]],
    [[P, "  - "], [T, "Calculadora"], [P, " "], [A, "→"], [S, " câmbio internacional "], [P, "["], [T, "Live"], [P, "]"]],
    [[P, "  - "], [T, "Oráculo Financeiro"], [P, " "], [A, "→"], [S, " renda fixa IPCA+ "], [P, "["], [T, "Live"], [P, "]"]],
    [[P, "  - "], [T, "cross-review"], [P, " "], [A, "→"], [S, " revisão por 6 AIs "], [P, "["], [T, "npm"], [P, "]"]],
    [[P, "  - "], [T, "Ultrabrain MCP"], [P, " "], [A, "→"], [S, " raciocínio estruturado "], [P, "["], [T, "npm"], [P, "]"]],
    [[P, "  - "], [T, "Maestro"], [P, " "], [A, "→"], [S, " bancada editorial "], [P, "["], [T, "Shipping"], [P, "]"]],
    [[K, "plataforma"], [P, ":"]],
    [[P, "  "], [K, "edge"], [P, ":  ["], [S, "CF Pages, Workers, D1, R2, Access"], [P, "]"]],
    [[P, "  "], [K, "front"], [P, ": ["], [S, "React 19, Vite 8, TypeScript"], [P, "]"]],
    [[P, "  "], [K, "ai"], [P, ":    ["], [S, "6 modelos independentes em review"], [P, "]"]],
    [[P, "  "], [K, "gates"], [P, ": ["], [S, "unanimidade, rulesets, SHA pins"], [P, "]"]],
    [[K, "lema"], [P, ": >-"]],
    [[P, "  "], [S, "\"Fail closed, test first, ship through pull requests.\""]],
  ];

  const code = document.getElementById("editor-code");
  const gutter = document.getElementById("editor-gutter");
  const progress = document.getElementById("editor-progress");
  const skipBtn = document.getElementById("editor-skip");

  const totalChars = YAML.reduce(
    (sum, line) => sum + line.reduce((s, seg) => s + seg[1].length, 0) + 1, 0
  );

  function renderAll() {
    code.textContent = "";
    gutter.textContent = "";
    YAML.forEach((line, i) => {
      const li = document.createElement("li");
      li.textContent = String(i + 1);
      gutter.appendChild(li);
      line.forEach(([cls, text]) => {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        code.appendChild(span);
      });
      code.appendChild(document.createTextNode("\n"));
    });
    if (progress) progress.textContent = "100%";
    if (skipBtn) skipBtn.remove();
  }

  function typeYaml() {
    let li = 0, si = 0, ci = 0, typed = 0, skipped = false;
    const caret = document.createElement("span");
    caret.className = "editor__caret";
    code.appendChild(caret);
    let currentSpan = null;

    skipBtn.addEventListener("click", () => { skipped = true; });

    function newLineNumber() {
      const n = document.createElement("li");
      n.textContent = String(li + 1);
      gutter.appendChild(n);
    }
    newLineNumber();

    function step() {
      if (skipped) { renderAll(); return; }
      const delay = typed < 120 ? 26 : typed < 400 ? 14 : 7;
      const line = YAML[li];
      if (!line) { caret.remove(); if (progress) progress.textContent = "100%"; if (skipBtn) skipBtn.remove(); return; }
      const seg = line[si];
      if (!seg) {
        code.insertBefore(document.createTextNode("\n"), caret);
        currentSpan = null;
        li += 1; si = 0; ci = 0; typed += 1;
        if (li < YAML.length) newLineNumber();
        code.parentElement.scrollTop = code.parentElement.scrollHeight;
        setTimeout(step, delay * 2);
        return;
      }
      if (!currentSpan) {
        currentSpan = document.createElement("span");
        currentSpan.className = seg[0];
        code.insertBefore(currentSpan, caret);
      }
      currentSpan.textContent += seg[1][ci];
      ci += 1; typed += 1;
      if (progress) progress.textContent = Math.min(99, Math.round((typed / totalChars) * 100)) + "%";
      if (ci >= seg[1].length) { si += 1; ci = 0; currentSpan = null; }
      setTimeout(step, delay);
    }
    step();
  }

  if (code && gutter) {
    if (reduceMotion) {
      renderAll();
    } else {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); typeYaml(); }
      }, { threshold: 0.25 });
      io.observe(code);
    }
  }

  /* ============ rotação de frases do hero ============ */
  const ROLES = [
    "Transformando Ideias em Software",
    "React 19 • Cloudflare Edge • Rust/Tauri",
    "6 agentes de AI revisam cada deploy",
    "Fail closed, test first, ship through pull requests",
  ];
  const roleEl = document.getElementById("role-type");
  if (roleEl && !reduceMotion) {
    let idx = 0;
    function swapRole() {
      idx = (idx + 1) % ROLES.length;
      const next = ROLES[idx];
      let erase = roleEl.textContent.length;
      (function eraseStep() {
        if (erase > 0) {
          erase -= 1;
          roleEl.textContent = roleEl.textContent.slice(0, -1);
          setTimeout(eraseStep, 16);
        } else {
          let w = 0;
          (function writeStep() {
            if (w < next.length) {
              w += 1;
              roleEl.textContent = next.slice(0, w);
              setTimeout(writeStep, 34);
            } else {
              setTimeout(swapRole, 2600);
            }
          })();
        }
      })();
    }
    setTimeout(swapRole, 3000);
  }

  /* ============ contadores animados ============ */
  function animateCount(el, target) {
    if (reduceMotion) { el.textContent = String(target); return; }
    const dur = 900, t0 = performance.now();
    (function tick(t) {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }
  const stats = document.querySelectorAll(".stat dd");
  if (stats.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          animateCount(e.target, Number(e.target.dataset.count) || 0);
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.6 });
    stats.forEach((el) => io.observe(el));
  }

  /* ============ indicadores ao vivo da API do GitHub (a cada visita) ============ */
  function setLive(id, value) {
    const el = document.getElementById(id);
    if (el && typeof value === "number") {
      el.dataset.count = String(value);
      el.textContent = String(value);
    }
  }
  fetch("https://api.github.com/orgs/LCV-Ideas-Software")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      setLive("stat-repos", data.public_repos);
      const rEl = document.getElementById("orgcard-repos");
      if (rEl && typeof data.public_repos === "number") rEl.textContent = String(data.public_repos);
      const fEl = document.getElementById("orgcard-followers");
      if (fEl && typeof data.followers === "number") fEl.textContent = String(data.followers);
      const jEl = document.getElementById("orgcard-created");
      if (jEl && data.created_at) {
        const created = new Date(data.created_at);
        jEl.textContent = "No GitHub desde " +
          created.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      }
    })
    .catch(() => {});

  /* ============ reveals por scroll ============ */
  const revealed = document.querySelectorAll(".reveal");
  if (reduceMotion) {
    revealed.forEach((el) => el.classList.add("is-in"));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealed.forEach((el) => io.observe(el));
  }

  /* ============ ano do rodapé ============ */
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
