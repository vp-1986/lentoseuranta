// ── State ────────────────────────────────────────────────────────────────────
let config = {};
let priceHistory = { prices: [] };
let chart = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function getGitHubSettings() {
  return {
    token: localStorage.getItem("gh_token") || "",
    owner: localStorage.getItem("gh_owner") || "",
    repo: localStorage.getItem("gh_repo") || "flight-price-agent",
  };
}

// ── Chart ────────────────────────────────────────────────────────────────────
function renderChart(prices, threshold) {
  const canvas = document.getElementById("priceChart");
  const emptyEl = document.getElementById("empty-state");

  if (prices.length === 0) {
    canvas.style.display = "none";
    emptyEl.style.display = "block";
    return;
  }

  canvas.style.display = "block";
  emptyEl.style.display = "none";

  const labels = prices.map((p) => p.date);
  const data = prices.map((p) => p.cheapest_price);

  // Detect route changes to draw vertical separators
  const routeChanges = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1].search_params;
    const curr = prices[i].search_params;
    if (
      prev &&
      curr &&
      (prev.origin !== curr.origin ||
        prev.destination !== curr.destination ||
        prev.departure_date !== curr.departure_date ||
        prev.return_date !== curr.return_date)
    ) {
      routeChanges.push({
        type: "line",
        xMin: i,
        xMax: i,
        borderColor: "rgba(239,68,68,0.4)",
        borderWidth: 2,
        borderDash: [4, 4],
        label: {
          display: true,
          content: "Config changed",
          position: "start",
          color: "#f87171",
          font: { size: 10 },
        },
      });
    }
  }

  if (chart) chart.destroy();

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Cheapest Price (EUR)",
          data,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59,130,246,0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: data.map((d) =>
            d <= threshold ? "#22c55e" : "#3b82f6"
          ),
          pointBorderColor: data.map((d) =>
            d <= threshold ? "#22c55e" : "#3b82f6"
          ),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel(ctx) {
              const entry = prices[ctx.dataIndex];
              const lines = [`Results found: ${entry.num_results}`];
              if (entry.cheapest_airline)
                lines.push(`Airline: ${entry.cheapest_airline}`);
              if (entry.search_params) {
                lines.push(
                  `Route: ${entry.search_params.origin} → ${entry.search_params.destination}`
                );
              }
              return lines;
            },
          },
        },
        annotation: {
          annotations: {
            thresholdLine: {
              type: "line",
              yMin: threshold,
              yMax: threshold,
              borderColor: "rgba(245,158,11,0.7)",
              borderWidth: 2,
              borderDash: [6, 4],
              label: {
                display: true,
                content: `Threshold: ${threshold} €`,
                position: "end",
                color: "#f59e0b",
                backgroundColor: "rgba(30,41,59,0.8)",
                font: { size: 12, weight: "bold" },
              },
            },
            ...Object.fromEntries(
              routeChanges.map((rc, i) => [`routeChange${i}`, rc])
            ),
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", maxRotation: 45 },
          grid: { color: "rgba(51,65,85,0.5)" },
        },
        y: {
          ticks: {
            color: "#94a3b8",
            callback: (v) => v.toLocaleString() + " €",
          },
          grid: { color: "rgba(51,65,85,0.5)" },
        },
      },
    },
  });
}

// ── Stats ────────────────────────────────────────────────────────────────────
function renderStats(prices, threshold) {
  const row = document.getElementById("stats-row");
  if (prices.length === 0) {
    row.style.display = "none";
    return;
  }
  row.style.display = "grid";

  const latest = prices[prices.length - 1].cheapest_price;
  const lowest = Math.min(...prices.map((p) => p.cheapest_price));
  const belowClass = latest <= threshold ? "below" : "above";

  document.getElementById("stat-cheapest").textContent = `${latest.toLocaleString()} €`;
  document.getElementById("stat-cheapest").className = `stat-value ${belowClass}`;

  document.getElementById("stat-lowest").textContent = `${lowest.toLocaleString()} €`;
  document.getElementById("stat-lowest").className = `stat-value ${lowest <= threshold ? "below" : "above"}`;

  document.getElementById("stat-threshold").textContent = `${threshold.toLocaleString()} €`;

  // Trend: compare last two entries
  const trendEl = document.getElementById("stat-trend");
  if (prices.length >= 2) {
    const prev = prices[prices.length - 2].cheapest_price;
    const diff = latest - prev;
    if (diff < 0) {
      trendEl.textContent = `↓ ${Math.abs(diff)} €`;
      trendEl.className = "stat-value trend-down";
    } else if (diff > 0) {
      trendEl.textContent = `↑ ${diff} €`;
      trendEl.className = "stat-value trend-up";
    } else {
      trendEl.textContent = "→ No change";
      trendEl.className = "stat-value trend-flat";
    }
  } else {
    trendEl.textContent = "—";
    trendEl.className = "stat-value trend-flat";
  }
}

// ── Config Form ──────────────────────────────────────────────────────────────
function populateForm(cfg) {
  document.getElementById("origin").value = cfg.origin || "";
  document.getElementById("destination").value = cfg.destination || "";
  document.getElementById("departure_date").value = cfg.departure_date || "";
  document.getElementById("return_date").value = cfg.return_date || "";
  document.getElementById("adults").value = cfg.adults || 1;
  document.getElementById("children").value = cfg.children || 0;
  document.getElementById("stops").value = cfg.stops ?? 0;
  document.getElementById("price_threshold_eur").value = cfg.price_threshold_eur || 3000;
}

function readForm() {
  return {
    origin: document.getElementById("origin").value.toUpperCase().trim(),
    destination: document.getElementById("destination").value.toUpperCase().trim(),
    departure_date: document.getElementById("departure_date").value,
    return_date: document.getElementById("return_date").value,
    adults: parseInt(document.getElementById("adults").value, 10),
    children: parseInt(document.getElementById("children").value, 10),
    stops: parseInt(document.getElementById("stops").value, 10),
    price_threshold_eur: parseInt(document.getElementById("price_threshold_eur").value, 10),
  };
}

async function saveConfigViaGitHub(newConfig) {
  const { token, owner, repo } = getGitHubSettings();
  const path = "docs/data/config.json";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Get current file SHA
  const getRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) throw new Error(`Failed to read file: ${getRes.status}`);
  const fileData = await getRes.json();

  // Update file
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(newConfig, null, 2) + "\n")));
  const putRes = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Update flight search config from dashboard",
      content,
      sha: fileData.sha,
    }),
  });

  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(err.message || `GitHub API error: ${putRes.status}`);
  }
}

async function handleSave(e) {
  e.preventDefault();
  const statusEl = document.getElementById("save-status");
  const newConfig = readForm();
  const { token, owner } = getGitHubSettings();

  if (token && owner) {
    // Save directly via GitHub API
    statusEl.textContent = "Saving…";
    try {
      await saveConfigViaGitHub(newConfig);
      statusEl.textContent = "✓ Saved to repository!";
      config = newConfig;
      updateSubtitle();
    } catch (err) {
      statusEl.textContent = `✗ Error: ${err.message}`;
      statusEl.style.color = "#ef4444";
    }
  } else {
    // Fallback: copy JSON to clipboard
    const json = JSON.stringify(newConfig, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      statusEl.textContent = "✓ Config JSON copied to clipboard — paste it into docs/data/config.json in your repo.";
    } catch {
      // If clipboard fails, show in a prompt
      prompt("Copy this config JSON and paste into docs/data/config.json:", json);
      statusEl.textContent = "Copy the JSON into docs/data/config.json";
    }
  }

  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.style.color = "";
  }, 5000);
}

// ── GitHub Token ─────────────────────────────────────────────────────────────
function setupTokenHandlers() {
  const tokenInput = document.getElementById("github-token");
  const ownerInput = document.getElementById("repo-owner");
  const repoInput = document.getElementById("repo-name");

  // Load saved values
  const settings = getGitHubSettings();
  if (settings.token) tokenInput.value = "••••••••";
  ownerInput.value = settings.owner;
  repoInput.value = settings.repo;

  document.getElementById("save-token-btn").addEventListener("click", () => {
    const token = tokenInput.value.trim();
    if (token && !token.startsWith("••")) {
      localStorage.setItem("gh_token", token);
    }
    localStorage.setItem("gh_owner", ownerInput.value.trim());
    localStorage.setItem("gh_repo", repoInput.value.trim());
    tokenInput.value = "••••••••";
    alert("GitHub settings saved.");
  });

  document.getElementById("clear-token-btn").addEventListener("click", () => {
    localStorage.removeItem("gh_token");
    localStorage.removeItem("gh_owner");
    localStorage.removeItem("gh_repo");
    tokenInput.value = "";
    ownerInput.value = "";
    repoInput.value = "flight-price-agent";
    alert("GitHub settings cleared.");
  });
}

// ── Subtitle ─────────────────────────────────────────────────────────────────
function updateSubtitle() {
  const el = document.getElementById("route-subtitle");
  const pax = [];
  if (config.adults) pax.push(`${config.adults} adult${config.adults > 1 ? "s" : ""}`);
  if (config.children) pax.push(`${config.children} child${config.children > 1 ? "ren" : ""}`);
  const stopsLabel = config.stops === 0 ? "Direct" : config.stops === 3 ? "Any stops" : `≤${config.stops} stop(s)`;
  el.textContent = `${config.origin} → ${config.destination} · ${config.departure_date} – ${config.return_date} · ${pax.join(" + ")} · ${stopsLabel}`;
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    [config, priceHistory] = await Promise.all([
      fetchJSON("data/config.json"),
      fetchJSON("data/price_history.json"),
    ]);
  } catch (err) {
    console.error("Failed to load data:", err);
    document.getElementById("route-subtitle").textContent = "Error loading data. Check console.";
    return;
  }

  updateSubtitle();
  renderChart(priceHistory.prices, config.price_threshold_eur);
  renderStats(priceHistory.prices, config.price_threshold_eur);
  populateForm(config);

  document.getElementById("config-form").addEventListener("submit", handleSave);
  setupTokenHandlers();
}

init();
