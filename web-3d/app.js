import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ================================================================
// NAVIGATION & PAGE MANAGEMENT
// ================================================================
let currentPage = 'live';

// =====================================================================
//  ACTIVITY LOG — fed by onMessageArrived, shown on Overview page
// =====================================================================
const ACTIVITY_MAX = 50;
const activityLog  = []; // { time, text, severity }

function _logEvent(text, severity = 'info') {
    const now = new Date();
    const ts  = now.getHours().toString().padStart(2,'0') + ':'
              + now.getMinutes().toString().padStart(2,'0') + ':'
              + now.getSeconds().toString().padStart(2,'0');
    activityLog.unshift({ time: ts, text, severity });
    if (activityLog.length > ACTIVITY_MAX) activityLog.pop();
    // live-refresh overview if open
    if (currentPage === 'overview') _refreshOverviewDynamic();
}

// =====================================================================
//  LIVE ASSET STATUS — helpers to read DOM chips from live twin
// =====================================================================
function _getAssetStatus(id) {
    // id = 'a1' | 'a2' | 'a3'
    const chip = document.getElementById(id + '-chip');
    if (!chip) return 'unknown';
    const txt = chip.textContent.trim().toLowerCase();
    if (txt.includes('critical') || txt.includes('anomaly') || txt.includes('failure')) return 'critical';
    if (txt.includes('warning') || txt.includes('stale') || txt.includes('degraded')) return 'warning';
    if (txt.includes('healthy') || txt.includes('normal') || txt.includes('optimal')) return 'healthy';
    return 'initializing';
}

function _countAlerts() {
    return ['a1','a2','a3'].filter(id => _getAssetStatus(id) === 'critical').length;
}

function _uptimeStr() {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const h   = Math.floor(sec / 3600);
    const m   = Math.floor((sec % 3600) / 60);
    const s   = sec % 60;
    return h > 0
        ? `${h}h ${m.toString().padStart(2,'0')}m`
        : `${m.toString().padStart(2,'0')}m ${s.toString().padStart(2,'0')}s`;
}

// Called every second to refresh dynamic elements on overview
function _refreshOverviewDynamic() {
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.textContent === String(v)) return;
        el.textContent = v;
        el.classList.remove('val-flash');
        void el.offsetWidth;
        el.classList.add('val-flash');
    };

    // KPI strip
    const alerts = _countAlerts();
    set('ov-uptime',  _uptimeStr());
    set('ov-msgs',    msgCount.toLocaleString());
    set('ov-alerts',  alerts);

    // Alert color
    const alertEl = document.getElementById('ov-alerts');
    if (alertEl) alertEl.style.color = alerts > 0 ? 'var(--accent-red)' : 'var(--accent-green)';

    // Asset status badges
    ['a1','a2','a3'].forEach(id => {
        const badge = document.getElementById('ov-badge-' + id);
        if (!badge) return;
        const status = _getAssetStatus(id);
        badge.className = 'status-badge ' + (status === 'initializing' ? 'warning' : status);
        badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    });

    // Last-seen
    ['A1','A2','A3'].forEach(id => {
        const el = document.getElementById('ov-lastseen-' + id.toLowerCase());
        if (!el) return;
        const ls = assetTelemetry[id] && assetTelemetry[id].lastSeen;
        if (!ls) { el.textContent = 'No data yet'; return; }
        const ago = Math.floor((Date.now() - ls) / 1000);
        el.textContent = ago < 5 ? 'Just now' : ago + 's ago';
    });

    // Activity log
    const logEl = document.getElementById('ov-activity-log');
    if (logEl && activityLog.length > 0) {
        logEl.innerHTML = activityLog.slice(0, 12).map(e => `
            <div class="activity-item">
                <span class="activity-time">${e.time}</span>
                <span class="activity-text" style="color:${
                    e.severity === 'critical' ? 'var(--accent-red)'
                  : e.severity === 'warning'  ? 'var(--accent-amber)'
                  : 'var(--text-primary)'}">${e.text}</span>
            </div>`).join('');
    } else if (logEl && activityLog.length === 0) {
        logEl.innerHTML = '<div class="activity-item"><span class="activity-text" style="color:var(--text-muted)">Waiting for MQTT data...</span></div>';
    }
}

// =====================================================================
//  VISUALISATION — Ring buffers (50 pts) fed by onMessageArrived
// =====================================================================
const VIZ_MAX = 50; // max data-points kept per series

// Latest text labels for A2 — set by onMessageArrived, used as fallback
// when ring buffers haven't received a value yet (first cycle takes ~60 s)
const a2LatestLabels = { cooler: null, valve: null };

const vizData = {
    A1: {
        failureProb: [],   // 0-100 %
        timestamps:  [],
    },
    A2: {
        cooler:     [],    // 0-100 %
        valve:      [],    // 0-100 %
        timestamps: [],
    },
    A3: {
        anomalyScore: [],  // 0-1
        timestamps:   [],
    },
    // message-rate counter (updated every second)
    msgRate: [],
    msgRateTs: [],
};

let _vizMsgCountLast = 0;   // used for msg/s calculation

function _vizPush(arr, val) {
    arr.push(val);
    if (arr.length > VIZ_MAX) arr.shift();
}

function _vizTimestamp() {
    const d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':'
         + d.getMinutes().toString().padStart(2,'0') + ':'
         + d.getSeconds().toString().padStart(2,'0');
}

// Tick: update msg/s ring buffer every second
setInterval(() => {
    const rate = msgCount - _vizMsgCountLast;
    _vizMsgCountLast = msgCount;
    _vizPush(vizData.msgRate,   rate);
    _vizPush(vizData.msgRateTs, _vizTimestamp());
    // if vis page is open, refresh live charts
    if (currentPage === 'visualisation') _vizRefreshCharts();
}, 1000);

function initNavigation() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const sidebarItems = document.querySelectorAll('.sidebar-item');

    // Toggle sidebar with hamburger button
    hamburgerBtn.addEventListener('click', () => {
        sidebar.classList.toggle('active');
        sidebarOverlay.classList.toggle('active');
    });

    // Close sidebar when clicking overlay
    sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
    });

    // Handle sidebar navigation
    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            navigateToPage(page);
            
            // Close sidebar
            sidebar.classList.remove('active');
            sidebarOverlay.classList.remove('active');
        });
    });
}

function navigateToPage(page) {
    currentPage = page;
    
    // Update active sidebar item
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === page) {
            item.classList.add('active');
        }
    });

    // Show/hide page contents
    document.querySelectorAll('.page-content').forEach(container => {
        container.classList.remove('active');
        if (container.dataset.page === page) {
            container.classList.add('active');
        }
    });

    // Show/hide UI overlay only on live page
    const uiOverlay = document.getElementById('ui-overlay');
    if (page === 'live') {
        uiOverlay.style.opacity = '1';
        uiOverlay.style.pointerEvents = 'auto';
    } else {
        uiOverlay.style.opacity = '0';
        uiOverlay.style.pointerEvents = 'none';
    }

    // Render page content
    if (page === 'overview') {
        renderOverviewPage();
    } else if (page === 'analytics') {
        renderAnalyticsPage();
    } else if (page === 'visualisation') {
        renderVisualisationPage();
    } else if (page === 'docs') {
        renderDocumentationPage();
    }
}

// Helper function to safely get text content
function getTextContent(id) {
    const el = document.getElementById(id);
    return el ? el.textContent : '—';
}

// =====================================================================
//  ASSET PANEL — 3D scene shift helpers
//  Base Y positions (set after buildA1/A2/A3 + ground creation)
//  We shift ground, grid & all asset groups by PANEL_LIFT when a
//  detail panel opens, then restore them when it closes.
// =====================================================================
const PANEL_LIFT = 60;         // units to raise everything when panel opens
let   panelLiftActive  = false; // guard against double-apply
let   sceneLiftedCount = 0;     // tracks if scene is physically lifted

function _applyPanelLift(delta) {
    // ground & grid (set globally after scene init — resolved at runtime)
    if (window._ground) window._ground.position.y += delta;
    if (window._grid)   window._grid.position.y   += delta;
    // all asset groups
    ['A1', 'A2', 'A3'].forEach(id => {
        const g = assets[id] && assets[id].group;
        if (g) g.position.y += delta;
    });
}

function raisePanelScene() {
    if (panelLiftActive) return;
    panelLiftActive = true;
    sceneLiftedCount++;
    _applyPanelLift(+PANEL_LIFT);
}

function restorePanelScene() {
    // Scene stays raised visually — just reset the open/close guard
    panelLiftActive = false;
}

// Asset detail panel functions
let _currentDetailAsset = null;   // track which asset is open for live refresh

function refreshDetailPanel() {
    if (!_currentDetailAsset || !_dsbCurrent) return;

    const layout = DSB_LAYOUT[_currentDetailAsset];
    const L = dsbLatest[_currentDetailAsset] || {};
    const statusFn = _DSB_STATUS_FN[_currentDetailAsset];
    const { chips, tiles } = statusFn ? statusFn(L) : { chips: '', tiles: '' };

    const panel = document.getElementById('asset-detail-panel');
    const chipsEl = panel.querySelector('.dsb-chips');
    if (chipsEl) chipsEl.innerHTML = chips;
    const tilesEl = panel.querySelector('.dsb-tiles');
    if (tilesEl) tilesEl.innerHTML = tiles;

    // Update header connection badge (always on since UNS streams)
    const conn = panel.querySelector('.dsb-conn');
    if (conn) {
        const ls = assetTelemetry[_currentDetailAsset]?.lastSeen || 0;
        const ok = ls && Date.now() - ls <= STALE_MS[_currentDetailAsset];
        conn.className = 'dsb-conn ' + (ok ? 'on' : 'off');
        conn.textContent = ok ? '● LIVE' : '● NO DATA';
    }

    // Redraw all charts
    for (const c of _dsbCurrent.charts) c.render();
}

function openAssetDetail(assetId) {
    _currentDetailAsset = assetId;
    const overlay = document.getElementById('asset-detail-overlay');
    const panel = document.getElementById('asset-detail-panel');
    const content = document.getElementById('detail-content');

    const layout = DSB_LAYOUT[assetId];
    const L = dsbLatest[assetId] || {};
    const statusFn = _DSB_STATUS_FN[assetId];
    const { chips, tiles } = statusFn ? statusFn(L) : { chips: '', tiles: '' };
    const accent = { A1: 'var(--a1-color)', A2: 'var(--a2-color)', A3: 'var(--a3-color)' }[assetId];
    const ls = assetTelemetry[assetId]?.lastSeen || 0;
    const ok = ls && Date.now() - ls <= STALE_MS[assetId];

    let html = '';

    // ── Header (copy exact simulator dashboard) ──
    html += `
      <div class="dsb-header">
        <div>
          <h2 style="color:${accent}">${layout.title}</h2>
          <div class="sub">${layout.subtitle}</div>
        </div>
        <div class="dsb-conn ${ok ? 'on' : 'off'}">${ok ? '● LIVE' : '● NO DATA'}</div>
      </div>
    `;

    // ── Tiles ──
    html += `<div class="dsb-tiles">${tiles}</div>`;
    // ── Chips ──
    html += `<div class="dsb-chips">${chips}</div>`;

    // ── Charts grid container (will be populated by JS) ──
    html += `<div class="dsb-charts-grid" id="dsb-charts-grid"></div>`;

    content.innerHTML = html;

    // Build chart instances now that DOM is painted
    const grid = document.getElementById('dsb-charts-grid');
    const charts = [];
    for (const cfg of layout.charts) {
        const wrap = document.createElement('div');
        wrap.className = 'dsb-chart-wrap';
        grid.appendChild(wrap);
        charts.push(new DsbChart(wrap, cfg));
    }
    _dsbCurrent = { assetId, charts };

    // Initial draw
    requestAnimationFrame(() => {
        for (const c of charts) c.render();
    });

    // Raise 3D scene so the machine is well visible in the background
    raisePanelScene();

    // Show panel
    overlay.style.display = 'block';
    setTimeout(() => {
        overlay.classList.add('active');
        panel.classList.add('active');
    }, 10);
}

function closeAssetDetail() {
    _currentDetailAsset = null;   // stop live refresh
    const overlay = document.getElementById('asset-detail-overlay');
    const panel = document.getElementById('asset-detail-panel');
    
    overlay.classList.remove('active');
    panel.classList.remove('active');

    // Restore 3D scene to original positions
    restorePanelScene();
    
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 300);
}

// =====================================================================
//  VISUALISATION PAGE
// =====================================================================

// Chart.js instances — kept so we can update data without re-rendering
const _vizCharts = {};

// Chart.js shared defaults (dark theme)
function _vizChartDefaults(color, label, unit = '') {
    return {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label,
                data: [],
                borderColor: color,
                backgroundColor: color + '22',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,14,26,0.92)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#94a3b8',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    callbacks: {
                        label: ctx => ` ${ctx.parsed.y}${unit}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
                    grid:  { color: 'rgba(255,255,255,0.04)' },
                },
                y: {
                    ticks: { color: '#64748b', font: { size: 10 } },
                    grid:  { color: 'rgba(255,255,255,0.06)' },
                }
            }
        }
    };
}

function _vizMultiChartDefaults(colors, labels, unit = '') {
    return {
        type: 'line',
        data: {
            labels: [],
            datasets: labels.map((lbl, i) => ({
                label: lbl,
                data: [],
                borderColor: colors[i],
                backgroundColor: colors[i] + '18',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: false,
                tension: 0.4,
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 }
                },
                tooltip: {
                    backgroundColor: 'rgba(10,14,26,0.92)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#94a3b8',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}${unit}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
                    grid:  { color: 'rgba(255,255,255,0.04)' },
                },
                y: {
                    ticks: { color: '#64748b', font: { size: 10 } },
                    grid:  { color: 'rgba(255,255,255,0.06)' },
                }
            }
        }
    };
}

function _vizInitCharts() {
    // Destroy stale instances (navigation back-and-forth)
    Object.values(_vizCharts).forEach(c => c.destroy());
    Object.keys(_vizCharts).forEach(k => delete _vizCharts[k]);

    const a1Color  = '#3b82f6';
    const a2cColor = '#00e5ff';
    const a2vColor = '#14b8a6';
    const a3Color  = '#8b5cf6';
    const rateColor = '#f59e0b';

    const get = id => document.getElementById(id);

    // A1 — Failure Probability
    if (get('viz-chart-a1')) {
        const cfg = _vizChartDefaults(a1Color, 'Failure Prob.', '%');
        cfg.options.scales.y.min = 0; cfg.options.scales.y.max = 100;
        cfg.data.labels               = [...vizData.A1.timestamps];
        cfg.data.datasets[0].data     = [...vizData.A1.failureProb];
        _vizCharts.a1 = new Chart(get('viz-chart-a1'), cfg);
    }

    // A2 — Cooler & Valve (multi-series) — values are health % (mapped from ZeMA classes)
    if (get('viz-chart-a2')) {
        const cfg = _vizMultiChartDefaults([a2cColor, a2vColor], ['Cooler health', 'Valve health'], '%');
        cfg.options.scales.y.min = 0; cfg.options.scales.y.max = 100;
        cfg.data.labels              = [...vizData.A2.timestamps];
        cfg.data.datasets[0].data    = [...vizData.A2.cooler];
        cfg.data.datasets[1].data    = [...vizData.A2.valve];
        _vizCharts.a2 = new Chart(get('viz-chart-a2'), cfg);
    }

    // A3 — Anomaly Score
    if (get('viz-chart-a3')) {
        const cfg = _vizChartDefaults(a3Color, 'Anomaly Score');
        cfg.options.scales.y.min = 0; cfg.options.scales.y.max = 1;
        // danger zone annotation via background plugin workaround
        cfg.data.labels              = [...vizData.A3.timestamps];
        cfg.data.datasets[0].data    = [...vizData.A3.anomalyScore];
        _vizCharts.a3 = new Chart(get('viz-chart-a3'), cfg);
    }

    // Msg/s rate
    if (get('viz-chart-rate')) {
        const cfg = _vizChartDefaults(rateColor, 'Messages/s', ' msg/s');
        cfg.options.scales.y.min = 0;
        cfg.data.labels              = [...vizData.msgRateTs];
        cfg.data.datasets[0].data    = [...vizData.msgRate];
        _vizCharts.rate = new Chart(get('viz-chart-rate'), cfg);
    }
}

function _vizRefreshCharts() {
    if (_vizCharts.a1) {
        _vizCharts.a1.data.labels           = [...vizData.A1.timestamps];
        _vizCharts.a1.data.datasets[0].data = [...vizData.A1.failureProb];
        _vizCharts.a1.update('none');
    }
    if (_vizCharts.a2) {
        _vizCharts.a2.data.labels           = [...vizData.A2.timestamps];
        _vizCharts.a2.data.datasets[0].data = [...vizData.A2.cooler];
        _vizCharts.a2.data.datasets[1].data = [...vizData.A2.valve];
        _vizCharts.a2.update('none');
    }
    if (_vizCharts.a3) {
        _vizCharts.a3.data.labels           = [...vizData.A3.timestamps];
        _vizCharts.a3.data.datasets[0].data = [...vizData.A3.anomalyScore];
        _vizCharts.a3.update('none');
    }
    if (_vizCharts.rate) {
        _vizCharts.rate.data.labels           = [...vizData.msgRateTs];
        _vizCharts.rate.data.datasets[0].data = [...vizData.msgRate];
        _vizCharts.rate.update('none');
    }

    // Refresh KPI strip values
    const a1Latest  = vizData.A1.failureProb.at(-1)   ?? null;
    const a2cLatest = vizData.A2.cooler.at(-1)         ?? null;
    const a2vLatest = vizData.A2.valve.at(-1)          ?? null;
    const a3Latest  = vizData.A3.anomalyScore.at(-1)   ?? null;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.textContent === String(val)) return;   // no change → no redraw
        el.textContent = val;
        el.classList.remove('val-flash');
        // force reflow so the animation restarts
        void el.offsetWidth;
        el.classList.add('val-flash');
    };

    // KPI strip (top)
    // A2: if ring buffer has a value show %, otherwise fall back to the text label
    // stored the moment the last MQTT analytics message arrived (set before ring push)
    const a2cDisplay = a2cLatest !== null ? a2cLatest.toFixed(0) + '%'
                     : (a2LatestLabels.cooler ?? '—');
    const a2vDisplay = a2vLatest !== null ? a2vLatest.toFixed(0) + '%'
                     : (a2LatestLabels.valve  ?? '—');

    set('viz-kpi-a1',  a1Latest  !== null ? a1Latest.toFixed(1)  + '%' : '—');
    set('viz-kpi-a2c', a2cDisplay);
    set('viz-kpi-a2v', a2vDisplay);
    set('viz-kpi-a3',  a3Latest  !== null ? a3Latest.toFixed(3)        : '—');

    // Chart card "Latest" stats
    set('viz-a1-latest',  a1Latest  !== null ? a1Latest.toFixed(1)  + '%' : '—');
    set('viz-a3-latest',  a3Latest  !== null ? a3Latest.toFixed(3)        : '—');
    set('viz-a2c-latest', a2cDisplay);
    set('viz-a2v-latest', a2vDisplay);
}

function renderVisualisationPage() {
    const page = document.getElementById('page-visualisation');

    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">
                <span class="viz-live-dot"></span>Visualisation
            </h1>

            <!-- KPI strip -->
            <div class="viz-kpi-strip">
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A1 — Failure Prob.</div>
                    <div class="viz-kpi-value" id="viz-kpi-a1" style="color:var(--a1-color)">—</div>
                </div>
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A2 — Cooler</div>
                    <div class="viz-kpi-value" id="viz-kpi-a2c" style="color:var(--a2-color)">—</div>
                </div>
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A2 — Valve</div>
                    <div class="viz-kpi-value" id="viz-kpi-a2v" style="color:#14b8a6">—</div>
                </div>
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A3 — Anomaly Score</div>
                    <div class="viz-kpi-value" id="viz-kpi-a3" style="color:var(--a3-color)">—</div>
                </div>
            </div>

            <!-- Row 1: A1 + A3 -->
            <div class="viz-grid">
                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot a1"></span>
                            A1 — CNC Failure Probability
                        </div>
                        <span class="chart-card-badge">~10 s / part</span>
                    </div>
                    <div class="chart-canvas-wrap">
                        <canvas id="viz-chart-a1"></canvas>
                    </div>
                    <div class="chart-status-row">
                        <div class="chart-stat">
                            <span class="chart-stat-label">Latest</span>
                            <span class="chart-stat-value" id="viz-a1-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Data Points</span>
                            <span class="chart-stat-value">${vizData.A1.failureProb.length}</span>
                        </div>
                    </div>
                </div>

                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot a3"></span>
                            A3 — APU Anomaly Score
                        </div>
                        <span class="chart-card-badge">60× · pred/10 s</span>
                    </div>
                    <div class="chart-canvas-wrap">
                        <canvas id="viz-chart-a3"></canvas>
                    </div>
                    <div class="chart-status-row">
                        <div class="chart-stat">
                            <span class="chart-stat-label">Latest</span>
                            <span class="chart-stat-value" id="viz-a3-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Threshold</span>
                            <span class="chart-stat-value">0.347</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Row 2: A2 full width -->
            <div class="viz-grid-full">
                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot a2"></span>
                            A2 — Hydraulic System Condition
                        </div>
                        <span class="chart-card-badge">1 Hz · pred/60 s</span>
                    </div>
                    <div class="chart-canvas-wrap" style="height:200px">
                        <canvas id="viz-chart-a2"></canvas>
                    </div>
                    <div class="chart-status-row">
                        <div class="chart-stat">
                            <span class="chart-stat-label">Cooler (latest)</span>
                            <span class="chart-stat-value" id="viz-a2c-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Valve (latest)</span>
                            <span class="chart-stat-value" id="viz-a2v-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Data Points</span>
                            <span class="chart-stat-value">${vizData.A2.timestamps.length}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Row 3: MQTT message rate -->
            <div class="viz-grid-full">
                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot" style="background:var(--accent-amber)"></span>
                            MQTT — Message Rate
                        </div>
                        <span class="chart-card-badge">Broker</span>
                    </div>
                    <div class="chart-canvas-wrap" style="height:140px">
                        <canvas id="viz-chart-rate"></canvas>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Initialise charts after DOM is painted
    requestAnimationFrame(() => {
        _vizInitCharts();
        _vizRefreshCharts();
    });
}

// =====================================================================
//  ANALYTICS — Live refresh helper
// =====================================================================
function _refreshAnalyticsDynamic() {
    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.textContent === String(val)) return;
        el.textContent = val;
        el.classList.remove('val-flash');
        void el.offsetWidth;
        el.classList.add('val-flash');
    };
    const setStyle = (id, prop, val) => { const el = document.getElementById(id); if (el) el.style[prop] = val; };

    // KPI numeric values from ring buffers
    if (vizData.A1.failureProb.length) {
        const v = vizData.A1.failureProb.at(-1).toFixed(1) + '%';
        setEl('an-kpi-a1', v);
        setStyle('an-kpi-a1', 'color', parseFloat(v) > 20 ? 'var(--accent-red)' : parseFloat(v) > 5 ? 'var(--accent-amber)' : 'var(--a1-color)');
    }
    if (vizData.A2.cooler.length) {
        const v = vizData.A2.cooler.at(-1);
        setEl('an-kpi-a2c', v.toFixed(0) + '%');
        setStyle('an-kpi-a2c', 'color', v < 30 ? 'var(--accent-red)' : v < 80 ? 'var(--accent-amber)' : 'var(--a2-color)');
    }
    if (vizData.A2.valve.length) {
        const v = vizData.A2.valve.at(-1);
        setEl('an-kpi-a2v', v.toFixed(0) + '%');
        setStyle('an-kpi-a2v', 'color', v < 30 ? 'var(--accent-red)' : v < 80 ? 'var(--accent-amber)' : 'var(--a2-color)');
    }
    if (vizData.A3.anomalyScore.length) {
        const v = vizData.A3.anomalyScore.at(-1);
        setEl('an-kpi-a3', v.toFixed(3));
        setStyle('an-kpi-a3', 'color', v > 0.7 ? 'var(--accent-red)' : v > 0.4 ? 'var(--accent-amber)' : 'var(--a3-color)');
    }

    // Asset status badges in analytics
    ['a1','a2','a3'].forEach(id => {
        const badge = document.getElementById('an-badge-' + id);
        if (!badge) return;
        const status = _getAssetStatus(id);
        badge.className = 'status-badge ' + (status === 'initializing' ? 'warning' : status);
        badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    });

    // Live message count + uptime in analytics
    setEl('an-msg-count', msgCount.toLocaleString());
    setEl('an-uptime', _uptimeStr());
}

function renderOverviewPage() {
    const page = document.getElementById('page-overview');

    // Build asset rows dynamically
    const assetDefs = [
        { id: 'a1', label: 'A1 — CNC Milling',      zone: 'Workshop Zone 1' },
        { id: 'a2', label: 'A2 — Hydraulic System',  zone: 'Workshop Zone 1' },
        { id: 'a3', label: 'A3 — APU Compressor',    zone: 'Workshop Zone 2' },
    ];

    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">Overview</h1>

            <!-- Live KPI strip -->
            <div class="kpi-grid">
                <div class="kpi-card">
                    <div class="kpi-card-label">Session Uptime</div>
                    <div class="kpi-card-value" id="ov-uptime" style="color:var(--accent-cyan)">—</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">MQTT Messages</div>
                    <div class="kpi-card-value" id="ov-msgs" style="color:var(--accent-cyan)">—</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Active Alerts</div>
                    <div class="kpi-card-value" id="ov-alerts">—</div>
                </div>
            </div>

            <!-- Asset status cards -->
            <h2 class="section-title">Asset Status</h2>
            <div class="asset-grid">
                ${assetDefs.map(a => `
                    <div class="asset-status-card" onclick="navigateToPage('live')">
                        <div class="asset-status-header">
                            <div class="asset-status-name">${a.label}</div>
                            <span class="status-badge warning" id="ov-badge-${a.id}">Initializing</span>
                        </div>
                        <p style="color:var(--text-muted);font-size:13px;margin:6px 0 2px">${a.zone}</p>
                        <p style="color:var(--text-muted);font-size:12px">
                            Last data: <span id="ov-lastseen-${a.id}" style="color:var(--text-secondary)">No data yet</span>
                        </p>
                    </div>
                `).join('')}
            </div>

            <!-- Recent activity (live) -->
            <h2 class="section-title">Recent Activity</h2>
            <div class="activity-log" id="ov-activity-log">
                <div class="activity-item">
                    <span class="activity-text" style="color:var(--text-muted)">Waiting for MQTT data...</span>
                </div>
            </div>
        </div>
    `;

    // Immediate fill + start live refresh
    _refreshOverviewDynamic();
}

function renderAnalyticsPage() {
    const page = document.getElementById('page-analytics');

    // ── Real model metrics extracted from notebooks ──────────────────
    const models = [
        {
            name: 'CNC Failure Predictor',
            asset: 'A1', color: 'var(--a1-color)',
            type: 'Binary Classification + Per-Mode',
            algo: 'XGBoost + SMOTE (7 models)',
            dataset: 'AI4I 2020 (10 000 samples, 3.4% failure rate)',
            accuracy: '97.05%', f1: '82.75% macro / Binary F1: 81.75%', precision: '54.05%', recall: '88.24%',
            note: 'ROC-AUC=0.9855 · AP=0.8657. Per-mode: OSF F1=1.000 · PWF F1=0.929 · HDF F1=0.949 · TWF F1=0.115 Recall=0.500 (t=0.35, SMOTE + threshold tuned on original data) · RNF F1=0.029 Recall=0.500 (t=0.05, near-zero sensor correlation — truly random failures, threshold forced low to capture any signal).',
            status: 'active',
        },
        {
            name: 'Hydraulic Condition Monitor',
            asset: 'A2', color: 'var(--a2-color)',
            type: 'Multi-target Classification',
            algo: 'XGBoost (4 targets)',
            dataset: 'ZeMA Hydraulic (2 205 samples)',
            accuracy: 'Cooler 100% / Valve 98.9% / Pump 99.6% / Accum. 100%',
            f1: 'Cooler 100% / Valve 98.7% / Pump 99.6% / Accum. 100%',
            precision: '99–100%', recall: '99–100%',
            note: 'All 4 targets pass validation (≥98% macro-F1)',
            status: 'active',
        },
        {
            name: 'APU Anomaly Detector',
            asset: 'A3', color: 'var(--a3-color)',
            type: 'Unsupervised Anomaly Detection',
            algo: 'Isolation Forest + LSTM Autoencoder (Ensemble)',
            dataset: 'MetroPT-3 APU (1 516 948 samples)',
            accuracy: '4/4 failure windows detected',
            f1: '52.2% @ 96th-percentile threshold',
            precision: '49.3%', recall: '55.4%',
            note: 'Best ensemble threshold: 96th percentile (0.347). All 4 historical failure windows detected.',
            status: 'active',
        },
    ];

    // Live MQTT telemetry — read from vizData ring buffers (always up to date)
    const liveA1  = vizData.A1.failureProb.length   ? vizData.A1.failureProb.at(-1).toFixed(1) + '%' : (document.getElementById('a1-prob')?.textContent  || '—');
    const liveA2c = vizData.A2.cooler.length         ? vizData.A2.cooler.at(-1).toFixed(0)      + '%' : (document.getElementById('a2-cooler')?.textContent || '—');
    const liveA2v = vizData.A2.valve.length          ? vizData.A2.valve.at(-1).toFixed(0)       + '%' : (document.getElementById('a2-valve')?.textContent  || '—');
    const liveA3  = vizData.A3.anomalyScore.length   ? vizData.A3.anomalyScore.at(-1).toFixed(3)      : (document.getElementById('a3-score')?.textContent  || '—');

    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">Analytics</h1>

            <!-- Live inference KPIs — IDs allow onMessageArrived to keep them updated -->
            <h2 class="section-title">Live Inference Values</h2>
            <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
                <div class="kpi-card">
                    <div class="kpi-card-label">A1 — Failure Prob.</div>
                    <div class="kpi-card-value" id="an-kpi-a1" style="color:var(--a1-color);font-size:22px">${liveA1}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A2 — Cooler health</div>
                    <div class="kpi-card-value" id="an-kpi-a2c" style="color:var(--a2-color);font-size:22px">${liveA2c}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A2 — Valve health</div>
                    <div class="kpi-card-value" id="an-kpi-a2v" style="color:var(--a2-color);font-size:22px">${liveA2v}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A3 — Anomaly Score</div>
                    <div class="kpi-card-value" id="an-kpi-a3" style="color:var(--a3-color);font-size:22px">${liveA3}</div>
                </div>
            </div>

            <!-- Live session stats + asset status row -->
            <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr);margin-top:8px">
                <div class="kpi-card">
                    <div class="kpi-card-label">Session Uptime</div>
                    <div class="kpi-card-value" id="an-uptime" style="color:var(--accent-cyan);font-size:18px">—</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">MQTT Messages</div>
                    <div class="kpi-card-value" id="an-msg-count" style="color:var(--accent-cyan);font-size:18px">—</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A1 Status</div>
                    <div style="padding-top:6px"><span class="status-badge warning" id="an-badge-a1">Initializing</span></div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A2 Status</div>
                    <div style="padding-top:6px"><span class="status-badge warning" id="an-badge-a2">Initializing</span></div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A3 Status</div>
                    <div style="padding-top:6px"><span class="status-badge warning" id="an-badge-a3">Initializing</span></div>
                </div>
            </div>

            <!-- Model registry -->
            <h2 class="section-title">Model Registry</h2>
            <table class="model-table">
                <thead>
                    <tr>
                        <th>Model</th>
                        <th>Asset</th>
                        <th>Algorithm</th>
                        <th>Dataset</th>
                        <th>Accuracy</th>
                        <th>Macro F1</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${models.map(m => `
                        <tr>
                            <td style="font-weight:600;color:${m.color}">${m.name}</td>
                            <td>${m.asset}</td>
                            <td>${m.algo}</td>
                            <td style="font-size:12px;color:var(--text-muted)">${m.dataset}</td>
                            <td style="font-size:12px">${m.accuracy}</td>
                            <td style="font-size:12px">${m.f1}</td>
                            <td><span class="status-badge healthy">${m.status}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <!-- Per-model detail cards -->
            <h2 class="section-title">Model Details</h2>
            <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:24px">
                ${models.map(m => `
                    <div class="kpi-card" style="border-left:3px solid ${m.color}">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                            <div>
                                <span style="font-weight:600;color:${m.color};font-size:15px">${m.name}</span>
                                <span style="margin-left:10px;font-size:12px;color:var(--text-muted)">${m.type}</span>
                            </div>
                            <span class="status-badge healthy">Active</span>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:10px">
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Accuracy</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.accuracy}</div>
                            </div>
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Macro F1</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.f1}</div>
                            </div>
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Precision</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.precision}</div>
                            </div>
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Recall</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.recall}</div>
                            </div>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:8px">
                            ℹ ${m.note}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    // Immediate fill of live values
    _refreshAnalyticsDynamic();
}

const documentationMarkdown = `
# Documentation

Welcome to the JESA Digital Twin technical documentation.

## <a id="architecture">System Architecture</a>

The JESA Digital Twin system consists of three main components:

1. **3D Visualization Layer**: Real-time 3D representation of the factory floor using Three.js
2. **MQTT Data Pipeline**: Real-time data ingestion from sensors and edge devices
3. **Analytics Backend**: Machine learning models for predictive maintenance and anomaly detection

## <a id="assets">Sensor / Asset Reference</a>

### Asset A1: CNC Milling Machine
- **Location**: Workshop Zone 1
- **Sensors**: Air temperature (K), Process temperature (K), Rotational speed (rpm), Torque (Nm), Tool wear (min)
- **Data Frequency**: ~1 Hz (event-based, one sample per machined part ~5–10 s)
- **ML Model**: XGBoost binary classifier + 5 per-mode classifiers (TWF, HDF, PWF, OSF, RNF)

### Asset A2: Hydraulic System
- **Location**: Workshop Zone 1
- **Sensors**: 6× pressure (bar) at 100 Hz, 2× flow (l/min) at 10 Hz, 4× temperature (°C) at 1 Hz, vibration (mm/s) at 1 Hz, 3× virtual KPIs at 1 Hz
- **Data Frequency**: Published at 1 Hz (downsampled from 100 Hz raw); predictions per cycle (~60 s)
- **ML Model**: XGBoost — 4 independent condition classifiers (Cooler, Valve, Pump, Accumulator)

### Asset A3: APU Compressor
- **Location**: Workshop Zone 2
- **Sensors**: TP2, TP3, H1, DV_pressure, Reservoirs (bar), Oil temperature (°C), Motor current (A), COMP (digital)
- **Data Frequency**: 1 Hz continuous stream (replayed at 60× speed)
- **ML Model**: Ensemble — Isolation Forest + LSTM Autoencoder (anomaly detection)

## <a id="mqtt">MQTT Topic Schema</a>

\`\`\`
jesa/site1/
├── workshop/
│   ├── milling/A1/
│   │   ├── process/   air_temperature_k · process_temperature_k
│   │   ├── drive/     rotational_speed_rpm · torque_nm
│   │   ├── tool/      tool_wear_min
│   │   ├── analytics/ machine_failure · mode_twf · mode_hdf · mode_pwf · mode_osf · mode_rnf
│   │   └── metrics/   prediction_count · failure_count
│   └── hydraulics/A2/
│       ├── hydraulic/ ps1_bar … ps6_bar · flow1_lpm · flow2_lpm
│       ├── thermal/   ts1_c … ts4_c
│       ├── motor/     power_w · vibration_mms
│       ├── kpis/      cooling_efficiency_pct · cooling_power_kw · efficiency_factor_pct
│       ├── analytics/ cooler_condition · valve_condition · pump_leakage · accumulator_pressure
│       └── metrics/   cycle_count · degraded_cooler_count
└── fleet/apu/A3/
    ├── pneumatic/ tp2_bar · tp3_bar · h1_bar · dv_pressure_bar · reservoirs_bar
    ├── oil/       temperature_c
    ├── motor/     current_a
    ├── digital/   comp
    ├── analytics/ anomaly
    └── metrics/   prediction_count · anomaly_count
\`\`\`

## <a id="alerts">Alert Thresholds & Definitions</a>

| Alert Level | Failure Probability | Anomaly Score |
|-------------|---------------------|---------------|
| Healthy     | < 5%                | < 0.4         |
| Warning     | 5% - 20%            | 0.4 - 0.7     |
| Critical    | > 20%               | > 0.7         |

## <a id="troubleshooting">Troubleshooting</a>

### MQTT Connection Issues

If you see "MQTT failed: AMQJS0007E Socket error", check:

1. That the MQTT broker is running on localhost:9001
2. That there are no firewall rules blocking the connection
3. That the broker allows WebSocket connections
`;

function renderDocumentationPage() {
    const page = document.getElementById('page-docs');
    
    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">Documentation</h1>
            
            <div class="docs-container">
                <div class="docs-sidebar">
                    <input type="text" class="docs-search" id="docs-search" placeholder="Search documentation...">
                    <div id="docs-toc">
                        <div class="docs-toc-item active" data-section="all">All Sections</div>
                        <div class="docs-toc-item" data-section="architecture">System Architecture</div>
                        <div class="docs-toc-item" data-section="assets">Sensor / Asset Reference</div>
                        <div class="docs-toc-item" data-section="mqtt">MQTT Topic Schema</div>
                        <div class="docs-toc-item" data-section="alerts">Alert Thresholds & Definitions</div>
                        <div class="docs-toc-item" data-section="troubleshooting">Troubleshooting</div>
                    </div>
                </div>
                <div class="docs-content" id="docs-content">
                    ${marked.parse(documentationMarkdown)}
                </div>
            </div>
        </div>
    `;

    // Add search functionality
    const searchInput = document.getElementById('docs-search');
    const tocItems = document.querySelectorAll('.docs-toc-item');
    
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const content = document.getElementById('docs-content');
        
        if (query) {
            content.innerHTML = marked.parse(documentationMarkdown).toLowerCase().includes(query) 
                ? marked.parse(documentationMarkdown) 
                : '<p style="color: var(--text-muted)">No results found.</p>';
        } else {
            content.innerHTML = marked.parse(documentationMarkdown);
        }
    });

    // Add TOC click functionality
    tocItems.forEach(item => {
        item.addEventListener('click', () => {
            tocItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const section = item.dataset.section;
            if (section === 'all') {
                // Scroll to top
                const docsContent = document.getElementById('docs-content');
                docsContent.scrollTop = 0;
            } else {
                const targetElement = document.getElementById(section);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        });
    });
}

// =====================================================================
//  SCENE SETUP
// =====================================================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);
scene.fog = new THREE.FogExp2(0x0f172a, 0.008);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 18, 50);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

// Post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.8, 0.4, 0.85);
bloom.threshold = 0.35;
bloom.strength = 0.7;
bloom.radius = 0.4;
composer.addPass(bloom);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI / 2 - 0.08;
controls.minDistance = 15;
controls.maxDistance = 80;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;
controls.target.set(0, 4, 0);

// =====================================================================
//  LIGHTING — Industrial feel
// =====================================================================
scene.add(new THREE.AmbientLight(0xffffff, 1.2));

const keyLight = new THREE.DirectionalLight(0xdde4ff, 2.5);
keyLight.position.set(25, 35, 20);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -30; keyLight.shadow.camera.right = 30;
keyLight.shadow.camera.top = 30;   keyLight.shadow.camera.bottom = -30;
keyLight.shadow.bias = -0.0002;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x4488ff, 0.8);
fillLight.position.set(-15, 10, -10);
scene.add(fillLight);

const rimLight = new THREE.PointLight(0x00e5ff, 4, 60);
rimLight.position.set(-20, 8, 15);
scene.add(rimLight);

const rimLight2 = new THREE.PointLight(0x7b61ff, 3, 50);
rimLight2.position.set(20, 6, -10);
scene.add(rimLight2);

// =====================================================================
//  ENVIRONMENT
// =====================================================================
// Ground
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85, metalness: 0.1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 5;
ground.receiveShadow = true;
scene.add(ground);
window._ground = ground; // exposed for panel lift

// Grid
const grid = new THREE.GridHelper(120, 60, 0x00e5ff, 0x0a1530);
grid.position.y = 5.02;
grid.material.opacity = 0.12;
grid.material.transparent = true;
scene.add(grid);
window._grid = grid; // exposed for panel lift

// Subtle particles
const pCount = 600;
const pPos = new Float32Array(pCount * 3);
for (let i = 0; i < pCount * 3; i++) pPos[i] = (Math.random() - 0.5) * 80;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const pMat = new THREE.PointsMaterial({ size: 0.08, color: 0x00e5ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending });
const particles = new THREE.Points(pGeo, pMat);
particles.position.y = 15;
scene.add(particles);

// =====================================================================
//  MATERIALS LIBRARY
// =====================================================================
//  MATERIALS LIBRARY
//  Each factory fn registers the created material in _allMaterials
//  so applyTheme() can recolor them precisely.
// =====================================================================
const _allMaterials = []; // { mat, darkColor, lightColor, type }

function _reg(mat, darkColor, lightColor) {
    _allMaterials.push({ mat, darkColor, lightColor });
    return mat;
}

const MAT = {
    body:   ()  => _reg(new THREE.MeshStandardMaterial({ color: 0x3a4055, metalness: 0.7, roughness: 0.35 }), 0x3a4055, 0xd0d0d0),
    panel:  ()  => _reg(new THREE.MeshStandardMaterial({ color: 0x2a2e3e, metalness: 0.3, roughness: 0.6  }), 0x2a2e3e, 0xb8b8b8),
    dark:   ()  => _reg(new THREE.MeshStandardMaterial({ color: 0x1a1e2a, metalness: 0.5, roughness: 0.5  }), 0x1a1e2a, 0x999999),
    accent: (c) => _reg(new THREE.MeshStandardMaterial({ color: c,        metalness: 0.2, roughness: 0.3  }), c, c),
    glow:   (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.9, metalness: 0.1, roughness: 0.2 }), // glow never recolored
    glass:  ()  => _reg(new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.4 }), 0x1a3050, 0xc8d8e8),
    chrome: ()  => _reg(new THREE.MeshStandardMaterial({ color: 0x888899, metalness: 0.95, roughness: 0.08 }), 0x888899, 0xe0e0e0),
    rubber: ()  => _reg(new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.0, roughness: 0.95 }), 0x151515, 0x888888),
    pipe:   (c) => _reg(new THREE.MeshStandardMaterial({ color: c || 0x556677, metalness: 0.6, roughness: 0.3 }), c || 0x556677, 0xbbbbbb),
};

const COLORS = {
    good: 0x00e676, warning: 0xffab00, critical: 0xff1744,
    a1: 0x4d7cfe, a2: 0x00e5ff, a3: 0x7b61ff
};

// =====================================================================
//  ASSET STATE TRACKING
// =====================================================================
const assets = {
    A1: { group: null, glowParts: [], statusColor: COLORS.a1 },
    A2: { group: null, glowParts: [], statusColor: COLORS.a2 },
    A3: { group: null, glowParts: [], statusColor: COLORS.a3 },
};

const assetTelemetry = {
    A1: { lastSeen: 0, updates: 0 },
    A2: { lastSeen: 0, updates: 0 },
    A3: { lastSeen: 0, updates: 0 },
};

// A1: event-driven ~10s/part — stale after 15s (1.5× interval)
// A2: cycle-based, ML prediction every ~60s — stale after 70s
// A3: 60× replay, prediction every 10s — stale after 20s
const STALE_MS = { A1: 15000, A2: 70000, A3: 20000 };

// =====================================================================
//  HYSTÉRÉSIS & STALE GUARD — Évitent les états panne permanents
// =====================================================================
// A3 anomaly : il faut 3 prédictions successives AU-DESSUS du seuil haut
// pour passer en CRITICAL, puis 3 prédictions successives EN-DESSOUS du
// seuil bas pour repasser en HEALTHY. De plus si aucun message analytics
// reçu depuis STALE_MS[A3] on ne passe JAMAIS en critical.
const _a3 = {
    state: 'healthy',         // healthy | warning | critical
    anomalyStreakHi: 0,       // compteur successif score > SEUIL_HAUT
    anomalyStreakLo: 0,       // compteur successif score <= SEUIL_BAS
    lastAnalyticsTs: 0,       // dernier TS de /analytics/anomaly
    SEUIL_HAUT: 0.50,         // au-dessus = suspicion
    SEUIL_BAS:  0.40,         // en-dessous = retour normal confirmé
    STREAK_CONFIRM: 3,        // nombre de confirmations nécessaires
};

// A2 : tracker le dernier message analytics pour STALE guard
let _a2LastAnalyticsTs = 0;
// A2 : initialized flag — don't show condition values until sim loop has advanced past second 0
let _a2SimStarted = false;

// A1 : previous state to detect transitions (avoid log spam)
let _a1PrevState = '';   // '' | 'healthy' | 'warning' | 'critical'

// A2 : worst-case state across all 4 conditions (cooler, valve, pump, accumulator)
// Updated by each condition handler; drives chip + card glow + 3D glow
const _a2State = { cooler: 'healthy', valve: 'healthy', pump: 'healthy', accum: 'healthy' };
let   _a2PrevChipState = '';

function _a2WorstState() {
    const rank = { healthy: 0, warning: 1, critical: 2 };
    const all  = Object.values(_a2State);
    const max  = all.reduce((m, s) => rank[s] > rank[m] ? s : m, 'healthy');
    return max;  // 'healthy' | 'warning' | 'critical'
}

function _a2ApplyChip() {
    const worst = _a2WorstState();
    if (worst === _a2PrevChipState) return;   // no change — skip DOM writes
    _a2PrevChipState = worst;
    const label    = worst === 'critical' ? 'Critical' : worst === 'warning' ? 'Warning' : 'Healthy';
    const glowKey  = worst === 'critical' ? 'critical' : worst === 'warning' ? 'warning' : 'good';
    setChip('a2-chip', label, worst === 'healthy' ? 'healthy' : worst);
    setCardGlow('card-a2', 'asset-card ' + glowKey + '-glow');
    setAssetGlow('A2', COLORS[glowKey]);
}

// =====================================================================
//  ASSET DASHBOARD — Copie parfaite de sim/tools/dashboard.html
//  Alimenté directement par les topics UNS MQTT 1Hz (ring buffers 600 pts)
//  Aucune dépendance sur le serveur dashboard.py:8080
// =====================================================================

// --- Mapping sujet MQTT (snake_case UNS) ↔ dashboard key (CamelCase OPC UA) ---
// Chaque asset reçoit ses topics sur jesa/site1/<area>/<folder>/<tag> via UNS gateway 1 Hz
const _dsbUnsToKey = {
    // A1 — topics reçus sur jesa/site1/workshop/milling/A1/
    'A1@part/product_id':           'Part/ProductId',
    'A1@part/product_type':         'Part/ProductType',
    'A1@process/air_temperature_k': 'Process/AirTemperature_K',
    'A1@process/process_temperature_k': 'Process/ProcessTemperature_K',
    'A1@drive/rotational_speed_rpm':'Drive/RotationalSpeed_rpm',
    'A1@drive/torque_nm':           'Drive/Torque_Nm',
    'A1@tool/tool_wear_min':        'Tool/ToolWear_min',
    'A1@status/machine_failure':    'Status/MachineFailure',
    'A1@status/twf':                'Status/TWF',
    'A1@status/hdf':                'Status/HDF',
    'A1@status/pwf':                'Status/PWF',
    'A1@status/osf':                'Status/OSF',
    'A1@status/rnf':                'Status/RNF',
    'A1@simulation/part_index':     'Simulation/PartIndex',

    // A2 — topics reçus sur jesa/site1/workshop/hydraulics/A2/
    'A2@hydraulic/ps1_bar':         'Hydraulic/PS1_bar',
    'A2@hydraulic/ps2_bar':         'Hydraulic/PS2_bar',
    'A2@hydraulic/ps3_bar':         'Hydraulic/PS3_bar',
    'A2@hydraulic/ps4_bar':         'Hydraulic/PS4_bar',
    'A2@hydraulic/ps5_bar':         'Hydraulic/PS5_bar',
    'A2@hydraulic/ps6_bar':         'Hydraulic/PS6_bar',
    'A2@hydraulic/flow1_lpm':       'Hydraulic/Flow1_lpm',
    'A2@hydraulic/flow2_lpm':       'Hydraulic/Flow2_lpm',
    'A2@thermal/ts1_c':             'Thermal/TS1_C',
    'A2@thermal/ts2_c':             'Thermal/TS2_C',
    'A2@thermal/ts3_c':             'Thermal/TS3_C',
    'A2@thermal/ts4_c':             'Thermal/TS4_C',
    'A2@motor/power_w':             'Motor/Power_W',
    'A2@motor/vibration_mms':       'Motor/Vibration_mms',
    'A2@kpis/cooling_efficiency_pct':'KPIs/CoolingEfficiency_pct',
    'A2@kpis/cooling_power_kw':     'KPIs/CoolingPower_kW',
    'A2@kpis/efficiency_factor_pct':'KPIs/EfficiencyFactor_pct',
    'A2@condition/cooler_condition_pct':   'Condition/CoolerCondition_pct',
    'A2@condition/valve_condition_pct':    'Condition/ValveCondition_pct',
    'A2@condition/pump_leakage':           'Condition/PumpLeakage',
    'A2@condition/accumulator_pressure_bar':'Condition/AccumulatorPressure_bar',
    'A2@condition/stable_flag':            'Condition/StableFlag',
    // analytics topics (published by ml_inference_service)
    'A2@analytics/cooler_condition':       'Condition/CoolerCondition_pct',
    'A2@analytics/valve_condition':        'Condition/ValveCondition_pct',
    'A2@analytics/pump_leakage':           'Condition/PumpLeakage',
    'A2@analytics/accumulator_pressure':   'Condition/AccumulatorPressure_bar',
    'A2@simulation/cycle_index':           'Simulation/CycleIndex',
    'A2@simulation/cycle_second':          'Simulation/CycleSecond',

    // A3 — topics reçus sur jesa/site1/fleet/apu/A3/
    'A3@pneumatic/tp2_bar':         'Pneumatic/TP2_bar',
    'A3@pneumatic/tp3_bar':         'Pneumatic/TP3_bar',
    'A3@pneumatic/h1_bar':          'Pneumatic/H1_bar',
    'A3@pneumatic/dv_pressure_bar': 'Pneumatic/DVPressure_bar',
    'A3@pneumatic/reservoirs_bar':  'Pneumatic/Reservoirs_bar',
    'A3@oil/temperature_c':         'Oil/Temperature_C',
    'A3@motor/current_a':           'Motor/Current_A',
    'A3@digital/comp':              'Digital/COMP',
    'A3@digital/dv_electric':       'Digital/DVElectric',
    'A3@digital/towers':            'Digital/Towers',
    'A3@digital/mpg':               'Digital/MPG',
    'A3@digital/lps':               'Digital/LPS',
    'A3@digital/pressure_switch':   'Digital/PressureSwitch',
    'A3@digital/oil_level':         'Digital/OilLevel',
    'A3@digital/caudal_impulses':   'Digital/CaudalImpulses',
    'A3@simulation/row_index':      'Simulation/RowIndex',
    'A3@simulation/source_timestamp':'Simulation/SourceTimestamp',
};

// Layout charts par asset — match exact simulator dashboard.html
const DSB_LAYOUT = {
    A1: {
        title: 'A1 — CNC Milling Machine',
        subtitle: 'Event-driven · 1 sample / part (~10 s) · AI4I 2020 dataset replay at 1×',
        charts: [
            { title: 'Torque',        unit: 'Nm',
              series: [{ key: 'Drive/Torque_Nm',              label: 'Torque',  slot: 1 }] },
            { title: 'Rotational speed', unit: 'rpm',
              series: [{ key: 'Drive/RotationalSpeed_rpm',   label: 'Speed',   slot: 1 }] },
            { title: 'Temperatures',  unit: 'K',
              series: [
                { key: 'Process/AirTemperature_K',     label: 'Air',      slot: 1 },
                { key: 'Process/ProcessTemperature_K', label: 'Process',  slot: 2 },
              ] },
        ],
    },
    A2: {
        title: 'A2 — Hydraulic Test Rig',
        // Cycle-based: 60 s per cycle at 1 Hz → 1 sample/s published.
        // ML prediction fires once per cycle (every ~60 s real-time).
        subtitle: 'Cycle-based · 1 Hz sensor stream · prediction every 60 s · ZeMA dataset (2 205 cycles)',
        charts: [
            { title: 'Hydraulic pressures', unit: 'bar',
              series: [1, 2, 3, 4, 5, 6].map(i =>
                ({ key: `Hydraulic/PS${i}_bar`, label: `PS${i}`, slot: i })) },
            { title: 'Temperatures', unit: '°C',
              series: [1, 2, 3, 4].map(i =>
                ({ key: `Thermal/TS${i}_C`, label: `TS${i}`, slot: i })) },
            { title: 'Motor power', unit: 'W',
              series: [{ key: 'Motor/Power_W', label: 'Power', slot: 1 }] },
        ],
    },
    A3: {
        title: 'A3 — APU Air Compressor',
        // Timestamp-based: MetroPT-3 dataset is 1 Hz; replayed at 60× speed
        // → ~60 real samples/s, 1 dataset-day passes in ~24 min.
        // ML prediction every 10 s real-time (once 10 history rows are available).
        subtitle: 'Timestamp-based · 60× replay (1 dataset-day ≈ 24 min) · prediction every 10 s · MetroPT-3',
        charts: [
            { title: 'Pneumatic pressures', unit: 'bar',
              series: [
                { key: 'Pneumatic/TP2_bar',         label: 'TP2',       slot: 1 },
                { key: 'Pneumatic/TP3_bar',         label: 'TP3',       slot: 2 },
                { key: 'Pneumatic/H1_bar',          label: 'H1',        slot: 3 },
                { key: 'Pneumatic/DVPressure_bar',  label: 'DV',        slot: 5 },
                { key: 'Pneumatic/Reservoirs_bar',  label: 'Reservoirs',slot: 6 },
              ] },
            { title: 'Motor current', unit: 'A',
              series: [{ key: 'Motor/Current_A', label: 'Current', slot: 1 }] },
            { title: 'Oil temperature', unit: '°C',
              series: [{ key: 'Oil/Temperature_C', label: 'Oil', slot: 1 }] },
        ],
    },
};

// --- Ring buffers 600 points (10 minutes @ 1Hz) ---
const DSB_SERIES_MAX = 600;
const dsbRingBuffers = {
    A1: {},  // key -> { t:[], v:[] }
    A2: {},
    A3: {},
};
// Valeurs les plus récentes (pour tiles + chips) : map key -> valeur scalaire
const dsbLatest = { A1: {}, A2: {}, A3: {} };

function _dsbEnsureBuffer(assetId, key) {
    if (!dsbRingBuffers[assetId][key]) dsbRingBuffers[assetId][key] = { t: [], v: [] };
    return dsbRingBuffers[assetId][key];
}
function _dsbPush(assetId, key, val) {
    const buf = _dsbEnsureBuffer(assetId, key);
    const now = Date.now();
    buf.t.push(now);
    buf.v.push(val);
    while (buf.t.length > DSB_SERIES_MAX) { buf.t.shift(); buf.v.shift(); }
    dsbLatest[assetId][key] = val;
}
// Convertit topic MQTT jesa/site1/.../A?/folder/tag → AssetId + buffer key
function _dsbRouteTopic(topic, v) {
    // topic exemple : jesa/site1/workshop/milling/A1/process/air_temperature_k
    const m = topic.match(/\/(A[123])\/(.+)$/);
    if (!m) return false;
    const [, assetId, rest] = m;
    const lookupKey = `${assetId}@${rest}`;
    const dashboardKey = _dsbUnsToKey[lookupKey];
    if (!dashboardKey) return false;
    _dsbPush(assetId, dashboardKey, v);
    return true;
}
const _dsbCss = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const _dsbSeriesColor = slot => _dsbCss(`--dsb-s${slot}`) || '#888';
function _dsbFmt(v) {
    if (v == null || Number.isNaN(v)) return '-';
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (a >= 100)  return v.toFixed(1);
    return v.toFixed(2);
}
const _dsbFmtTime = ms => new Date(ms).toLocaleTimeString('en-GB');
function _dsbNiceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + 1; lo = lo - 1; }
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
    const first = Math.ceil(lo / step) * step, ticks = [];
    for (let v = first; v <= hi + 1e-9; v += step) ticks.push(v);
    return ticks;
}

// --- Classe Chart custom canvas (identique dashboard.html, préfixée dsb-) ---
class DsbChart {
    constructor(container, cfg) {
        this.cfg = cfg;
        this.hoverIdx = null;
        this.tableMode = false;

        const head = document.createElement('div');
        head.className = 'dsb-chart-head';
        head.innerHTML = `<h3>${cfg.title} (${cfg.unit})</h3>`;
        this.btn = document.createElement('button');
        this.btn.textContent = 'Table';
        this.btn.onclick = () => {
            this.tableMode = !this.tableMode;
            this.btn.textContent = this.tableMode ? 'Chart' : 'Table';
            this.render();
        };
        head.appendChild(this.btn);

        const root = document.createElement('div');
        root.className = 'dsb-chart';
        root.appendChild(head);

        if (cfg.series.length >= 2) {
            const legend = document.createElement('div');
            legend.className = 'dsb-legend';
            legend.innerHTML = cfg.series.map(s =>
                `<span><i style="background:${_dsbSeriesColor(s.slot)}"></i>${s.label}</span>`).join('');
            root.appendChild(legend);
        }

        this.plot = document.createElement('div');
        this.plot.className = 'dsb-plot';
        this.canvas = document.createElement('canvas');
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'dsb-tooltip';
        this.tableEl = document.createElement('div');
        this.plot.append(this.canvas, this.tooltip, this.tableEl);
        root.appendChild(this.plot);
        container.appendChild(root);

        this.canvas.addEventListener('pointermove', e => this._onHover(e));
        this.canvas.addEventListener('pointerleave', () => {
            this.hoverIdx = null;
            this.tooltip.style.display = 'none';
            this.draw();
        });
    }
    points(key, assetId) {
        const aId = assetId || _currentDetailAsset;
        const s = aId && dsbRingBuffers[aId] && dsbRingBuffers[aId][key];
        return s && s.t.length ? s : null;
    }
    extent(assetId) {
        const aId = assetId || _currentDetailAsset;
        let tLo = Infinity, tHi = -Infinity, vLo = Infinity, vHi = -Infinity, any = false;
        for (const s of this.cfg.series) {
            const p = this.points(s.key, aId);
            if (!p) continue;
            any = true;
            tLo = Math.min(tLo, p.t[0]); tHi = Math.max(tHi, p.t[p.t.length - 1]);
            for (const v of p.v) { vLo = Math.min(vLo, v); vHi = Math.max(vHi, v); }
        }
        if (!any) return null;
        if (vHi === vLo) { vHi += 1; vLo -= 1; }
        const pad = (vHi - vLo) * 0.08;
        return { tLo, tHi: Math.max(tHi, tLo + 1), vLo: vLo - pad, vHi: vHi + pad };
    }
    render() {
        this.canvas.style.display = this.tableMode ? 'none' : 'block';
        this.tableEl.innerHTML = '';
        if (this.tableMode) this._renderTable(); else this.draw();
    }
    draw() {
        const cv = this.canvas, dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth, h = cv.clientHeight || 150;
        if (!w) return;
        cv.width = w * dpr; cv.height = h * dpr;
        const ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        ctx.font = '10.5px system-ui, "Inter", sans-serif';

        const ext = this.extent();
        if (!ext) {
            ctx.fillStyle = _dsbCss('--text-muted');
            ctx.textAlign = 'center';
            ctx.fillText('waiting for data…', w / 2, h / 2);
            return;
        }
        const m = { l: 46, r: 12, t: 8, b: 18 };
        const X = t => m.l + (t - ext.tLo) / (ext.tHi - ext.tLo) * (w - m.l - m.r);
        const Y = v => m.t + (1 - (v - ext.vLo) / (ext.vHi - ext.vLo)) * (h - m.t - m.b);

        // gridlines + y ticks
        ctx.strokeStyle = _dsbCss('--border'); ctx.lineWidth = 1;
        ctx.fillStyle = _dsbCss('--text-muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const v of _dsbNiceTicks(ext.vLo, ext.vHi, 4)) {
            const y = Math.round(Y(v)) + 0.5;
            ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
            ctx.fillText(_dsbFmt(v), m.l - 6, y);
        }
        // x labels: first / last timestamp
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';  ctx.fillText(_dsbFmtTime(ext.tLo), m.l, h - 5);
        ctx.textAlign = 'right'; ctx.fillText(_dsbFmtTime(ext.tHi), w - m.r, h - 5);

        // crosshair
        if (this.hoverIdx != null) {
            const p0 = this.points(this.cfg.series[0].key);
            if (p0 && p0.t[this.hoverIdx] != null) {
                const x = Math.round(X(p0.t[this.hoverIdx])) + 0.5;
                ctx.strokeStyle = _dsbCss('--accent-cyan');
                ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke();
            }
        }

        // series lines
        for (const s of this.cfg.series) {
            const p = this.points(s.key);
            if (!p) continue;
            const color = _dsbSeriesColor(s.slot);
            ctx.strokeStyle = color; ctx.lineWidth = 2;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.beginPath();
            for (let i = 0; i < p.t.length; i++) {
                const x = X(p.t[i]), y = Y(p.v[i]);
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            }
            ctx.stroke();
            const xe = X(p.t[p.t.length - 1]), ye = Y(p.v[p.v.length - 1]);
            ctx.beginPath(); ctx.arc(xe, ye, 4, 0, 2 * Math.PI);
            ctx.fillStyle = color; ctx.fill();
            ctx.strokeStyle = _dsbCss('--bg-card'); ctx.lineWidth = 2; ctx.stroke();
        }
    }
    _onHover(e) {
        if (this.tableMode) return;
        const p0 = this.points(this.cfg.series[0].key);
        const ext = this.extent();
        if (!p0 || !ext) return;
        const rect = this.canvas.getBoundingClientRect();
        const frac = (e.clientX - rect.left - 46) / (rect.width - 46 - 12);
        const t = ext.tLo + Math.min(Math.max(frac, 0), 1) * (ext.tHi - ext.tLo);
        let best = 0;
        for (let i = 1; i < p0.t.length; i++)
            if (Math.abs(p0.t[i] - t) < Math.abs(p0.t[best] - t)) best = i;
        this.hoverIdx = best;

        const rows = this.cfg.series.map(s => {
            const p = this.points(s.key);
            const v = p ? p.v[Math.min(best, p.v.length - 1)] : null;
            return `<div class="tt-row"><i style="background:${_dsbSeriesColor(s.slot)}"></i>`
                 + `${s.label}<b>${_dsbFmt(v)}</b></div>`;
        }).join('');
        this.tooltip.innerHTML =
            `<div class="tt-time">${_dsbFmtTime(p0.t[best])} · ${this.cfg.unit}</div>${rows}`;
        this.tooltip.style.display = 'block';
        const xpx = e.clientX - rect.left;
        this.tooltip.style.left = Math.min(xpx + 14, rect.width - 160) + 'px';
        this.tooltip.style.top = '6px';
        this.draw();
    }
    _renderTable() {
        const p0 = this.points(this.cfg.series[0].key);
        if (!p0) { this.tableEl.innerHTML = '<div class="dsb-empty">waiting for data…</div>'; return; }
        const n = Math.min(12, p0.t.length);
        let html = `<table class="dsb-table"><tr><th>Time</th>`
            + this.cfg.series.map(s => `<th>${s.label}</th>`).join('') + '</tr>';
        for (let i = p0.t.length - n; i < p0.t.length; i++) {
            html += `<tr><td>${_dsbFmtTime(p0.t[i])}</td>` + this.cfg.series.map(s => {
                const p = this.points(s.key);
                return `<td>${_dsbFmt(p ? p.v[i] : null)}</td>`;
            }).join('') + '</tr>';
        }
        this.tableEl.innerHTML = html + '</table>';
    }
}

// --- Tiles + Chips functions par asset (copie exacte dashboard.html a1Status/a2Status/a3Status) ---
function _dsbChip(state, icon, text) {
    return `<span class="dsb-chip ${state}"><span class="ico">${icon}</span>${text}</span>`;
}
function _dsbToggleChip(on, text) {
    return `<span class="dsb-chip ${on ? 'on' : ''}"><span class="dot"></span>${text}</span>`;
}
function _dsbTile(label, value, unit = '') {
    return `<div class="dsb-tile"><div class="label">${label}</div>`
         + `<div class="value">${value}<span class="unit"> ${unit}</span></div></div>`;
}
function _dsbA1Status(L) {
    const modes = { TWF: 'Tool wear', HDF: 'Heat dissipation', PWF: 'Power', OSF: 'Overstrain', RNF: 'Random' };
    let chips = L['Status/MachineFailure']
        ? _dsbChip('critical', '✕', 'Machine failure')
        : _dsbChip('good', '✓', 'Operating');
    for (const [key, label] of Object.entries(modes))
        if (L[`Status/${key}`]) chips += _dsbChip('critical', '✕', label);
    const tiles =
        _dsbTile('Part',       `${L['Part/ProductId'] ?? '-'}`,
                 `type ${L['Part/ProductType'] ?? '-'}`) +
        _dsbTile('Parts machined', L['Simulation/PartIndex'] ?? '-') +
        _dsbTile('Tool wear',    L['Tool/ToolWear_min']    ?? '-', 'min');
    return { chips, tiles };
}
function _dsbA2Status(L) {
    // Show dashes when sim hasn't started yet (all class values still at OPC UA init default 0)
    const ready = _a2SimStarted;

    const grade = (value, map) => {
        if (!ready || value == null) return ['warning', '—'];
        return map[value] || ['warning', '!'];
    };

    const cooler = grade(L['Condition/CoolerCondition_pct'],
        { 100: ['good', '✓'], 20: ['serious', '▲'], 3: ['critical', '✕'], 0: ['critical', '✕'] });
    const valve  = grade(L['Condition/ValveCondition_pct'],
        { 100: ['good', '✓'], 90: ['warning', '!'], 80: ['serious', '▲'], 73: ['critical', '✕'] });
    const pump   = grade(L['Condition/PumpLeakage'],
        { 0: ['good', '✓'], 1: ['warning', '!'], 2: ['critical', '✕'] });
    const accu   = grade(L['Condition/AccumulatorPressure_bar'],
        { 130: ['good', '✓'], 115: ['warning', '!'], 100: ['serious', '▲'], 90: ['critical', '✕'] });

    // Cooler label: class integer → human text
    const coolerTxt = ready ? (() => {
        const m = { 100: 'Optimal', 20: 'Partial', 3: 'Near-Failure', 0: 'Failed' };
        const c = L['Condition/CoolerCondition_pct'];
        return m[c] != null ? `Cooler: ${m[c]}` : `Cooler class ${c}`;
    })() : 'Cooler —';

    // Valve label
    const valveTxt = ready ? (() => {
        const m = { 100: 'Optimal', 90: 'Small lag', 80: 'Severe lag', 73: 'Near-failure' };
        const c = L['Condition/ValveCondition_pct'];
        return m[c] != null ? `Valve: ${m[c]}` : `Valve class ${c}`;
    })() : 'Valve —';

    const pumpVal = L['Condition/PumpLeakage'];
    const pumpTxt = !ready ? 'Pump —'
                  : pumpVal === 0 ? 'Pump: No leak'
                  : pumpVal === 1 ? 'Pump: Weak leak'
                  : pumpVal === 2 ? 'Pump: Severe leak'
                  : `Pump class ${pumpVal}`;

    const accuVal = L['Condition/AccumulatorPressure_bar'];
    const accuTxt = !ready ? 'Accum. —'
                  : accuVal === 130 ? 'Accum.: Optimal'
                  : accuVal === 115 ? 'Accum.: Slightly reduced'
                  : accuVal === 100 ? 'Accum.: Severely reduced'
                  : accuVal === 90  ? 'Accum.: Near-failure'
                  : `Accum. ${accuVal} bar`;

    const chips =
        _dsbChip(cooler[0], cooler[1], coolerTxt) +
        _dsbChip(valve[0],  valve[1],  valveTxt)  +
        _dsbChip(pump[0],   pump[1],   pumpTxt)   +
        _dsbChip(accu[0],   accu[1],   accuTxt)   +
        _dsbToggleChip(!L['Condition/StableFlag'], 'Stable');

    const cycleIdx = L['Simulation/CycleIndex'];
    const cycleSec = L['Simulation/CycleSecond'];
    const tiles =
        _dsbTile('Cycle',        cycleIdx != null ? cycleIdx : '—', '/ 2205') +
        _dsbTile('Cycle second', cycleSec != null ? cycleSec : '—', 's');

    return { chips, tiles };
}
function _dsbA3Status(L) {
    let chips = '';
    chips += L['Digital/LPS']
        ? _dsbChip('critical', '✕', 'LPS: pressure < 7 bar')
        : _dsbChip('good', '✓', 'Pressure nominal');
    if (L['Digital/OilLevel']) chips += _dsbChip('warning', '!', 'Oil level low');
    chips += _dsbToggleChip(L['Digital/COMP'],         'COMP');
    chips += _dsbToggleChip(L['Digital/DVElectric'],   'Under load');
    chips += _dsbToggleChip(L['Digital/Towers'],       'Tower 2');
    chips += _dsbToggleChip(L['Digital/MPG'],          'MPG');
    chips += _dsbToggleChip(L['Digital/PressureSwitch'],'Pressure switch');
    const ts  = L['Simulation/SourceTimestamp'];
    const row = L['Simulation/RowIndex'];
    const tiles =
        _dsbTile('Dataset time', ts ? String(ts).replace('T', ' ').slice(0, 19) : '—') +
        _dsbTile('Row', row != null && row !== 0 ? Number(row).toLocaleString('en-US') : '—');
    return { chips, tiles };
}
const _DSB_STATUS_FN = { A1: _dsbA1Status, A2: _dsbA2Status, A3: _dsbA3Status };

// Références des chart instances pour l'asset actuellement ouvert
let _dsbCurrent = null;  // { assetId, charts: [DsbChart,...] }

// =====================================================================
//  A1 — CNC MILLING MACHINE (Detailed)
// =====================================================================
function buildA1() {
    const g = new THREE.Group();

    // === Main Enclosure ===
    const enclosure = new THREE.Mesh(new THREE.BoxGeometry(6, 5.5, 5), MAT.body());
    enclosure.position.set(0, 2.75, 0);
    enclosure.castShadow = true; enclosure.receiveShadow = true;
    g.add(enclosure);

    // Front window (glass panel)
    const glass = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 0.1), MAT.glass());
    glass.position.set(0, 3.2, 2.51);
    g.add(glass);

    // Window frame
    const frameMat = MAT.chrome();
    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 0.15), frameMat);
    frameTop.position.set(0, 4.75, 2.52); g.add(frameTop);
    const frameBot = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 0.15), frameMat);
    frameBot.position.set(0, 1.65, 2.52); g.add(frameBot);
    const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.22, 0.15), frameMat);
    frameL.position.set(-2.35, 3.2, 2.52); g.add(frameL);
    const frameR = frameL.clone(); frameR.position.x = 2.35; g.add(frameR);

    // === Spindle Head (on top) ===
    const spindleHousing = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.8, 2.5), MAT.panel());
    spindleHousing.position.set(0, 6.4, 0);
    spindleHousing.castShadow = true;
    g.add(spindleHousing);

    // Z-axis rail
    const zRail = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2, 16), MAT.chrome());
    zRail.position.set(-0.6, 6.4, 0.8); g.add(zRail);
    const zRail2 = zRail.clone(); zRail2.position.x = 0.6; g.add(zRail2);

    // Spindle motor
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.4, 24), MAT.dark());
    motor.position.set(0, 7.6, 0); g.add(motor);

    // Spindle collet/tool
    const collet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, 0.6, 12), MAT.chrome());
    collet.position.set(0, 5.2, 0); g.add(collet);

    // === Work Table ===
    const table = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.25, 3.5), MAT.chrome());
    table.position.set(0, 0.5, 0);
    table.castShadow = true; table.receiveShadow = true;
    g.add(table);

    // T-slot lines on table
    for (let i = -1.2; i <= 1.2; i += 0.6) {
        const slot = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.05, 0.08), MAT.dark());
        slot.position.set(0, 0.64, i); g.add(slot);
    }

    // === Control Panel (right side) ===
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3, 2.5), MAT.panel());
    panel.position.set(3.5, 2.5, 0);
    panel.castShadow = true;
    g.add(panel);

    // Screen on panel
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.5, 1.5), MAT.glow(0x1a3a5a));
    screen.position.set(3.77, 3.2, 0); g.add(screen);

    // Buttons
    for (let j = 0; j < 3; j++) {
        const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 12), MAT.accent(j === 0 ? 0x00e676 : j === 1 ? 0xffab00 : 0xff1744));
        btn.rotation.z = Math.PI / 2;
        btn.position.set(3.78, 2.0, -0.4 + j * 0.4);
        g.add(btn);
    }

    // === Base / Machine Bed ===
    const bed = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 6), MAT.dark());
    bed.position.set(0, 0.2, 0);
    bed.receiveShadow = true;
    g.add(bed);

    // Leveling feet
    for (const [x, z] of [[-3, -2.5], [3, -2.5], [-3, 2.5], [3, 2.5]]) {
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.15, 16), MAT.rubber());
        foot.position.set(x, 0.05, z); g.add(foot);
    }

    // === Status LED Ring (holographic ring on base) ===
    const glowMat = MAT.glow(COLORS.a1);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.06, 16, 80), glowMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);

    // Floating label ring
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.02, 8, 80), MAT.glow(COLORS.a1));
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = 0.6;
    g.add(ring2);

    assets.A1.group = g;
    assets.A1.glowParts = [glowMat, ring2.material];
    g.position.set(-18, 5, 0);
    scene.add(g);
}

// =====================================================================
//  A2 — HYDRAULIC POWER UNIT (Detailed)
// =====================================================================
function buildA2() {
    const g = new THREE.Group();

    // === Main Reservoir Tank (vertical cylinder) ===
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 5, 32), MAT.body());
    tank.position.set(0, 2.8, 0);
    tank.castShadow = true; tank.receiveShadow = true;
    g.add(tank);

    // Tank top cap
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.2, 32), MAT.panel());
    cap.position.set(0, 5.4, 0); g.add(cap);

    // Fill port on top
    const fillPort = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.3, 16), MAT.chrome());
    fillPort.position.set(0.8, 5.65, 0); g.add(fillPort);

    // Sight glass (oil level indicator)
    const sightGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.5, 12), MAT.glass());
    sightGlass.position.set(2.22, 2.8, 0); g.add(sightGlass);

    // === Motor-Pump Assembly (side) ===
    const motorBody = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2.8, 24), MAT.dark());
    motorBody.rotation.z = Math.PI / 2;
    motorBody.position.set(0, 1.5, -3.2);
    motorBody.castShadow = true;
    g.add(motorBody);

    // Motor end cap
    const endCap = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.15, 24), MAT.panel());
    endCap.rotation.z = Math.PI / 2;
    endCap.position.set(-1.5, 1.5, -3.2); g.add(endCap);

    // Coupling housing
    const coupling = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.5, 16), MAT.chrome());
    coupling.rotation.z = Math.PI / 2;
    coupling.position.set(1.6, 1.5, -3.2); g.add(coupling);

    // Motor cooling fins
    for (let i = -1; i <= 1; i += 0.25) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.4, 0.04), MAT.panel());
        fin.position.set(i, 1.5, -3.2 + 1.2); g.add(fin);
    }

    // === Manifold Block ===
    const manifold = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 1.5), MAT.panel());
    manifold.position.set(0, 1.2, 3);
    manifold.castShadow = true;
    g.add(manifold);

    // Solenoid valves on manifold
    for (let i = -1; i <= 1; i++) {
        const valve = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.4), MAT.dark());
        valve.position.set(i, 2.2, 3); g.add(valve);
        const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 12), MAT.accent(0x445566));
        coil.position.set(i, 2.8, 3); g.add(coil);
    }

    // === Pressure Lines (pipes between tank and manifold) ===
    const pipeMat = MAT.pipe(0x667788);
    // Supply line
    const supplyPath = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(1.5, 2.5, 1.1),
            new THREE.Vector3(1.8, 2.5, 2.0),
            new THREE.Vector3(1.5, 2.0, 2.8),
        ]), 20, 0.12, 8, false
    );
    g.add(new THREE.Mesh(supplyPath, pipeMat));

    // Return line
    const returnPath = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(-1.5, 3.5, 1.1),
            new THREE.Vector3(-1.8, 3.5, 2.0),
            new THREE.Vector3(-1.5, 2.0, 2.8),
        ]), 20, 0.12, 8, false
    );
    g.add(new THREE.Mesh(returnPath, pipeMat));

    // === Pressure Gauge ===
    const gaugeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.15, 24), MAT.chrome());
    gaugeBody.rotation.x = Math.PI / 2;
    gaugeBody.position.set(0, 3.5, 3.85); g.add(gaugeBody);
    const gaugeFace = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshStandardMaterial({ color: 0xf0f0e0, roughness: 0.9 }));
    gaugeFace.position.set(0, 3.5, 3.93); g.add(gaugeFace);

    // === Filter Housing ===
    const filter = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 16), MAT.accent(0x334455));
    filter.position.set(-2.8, 1.5, -1); g.add(filter);
    const filterCap = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 16), MAT.chrome());
    filterCap.position.set(-2.8, 2.45, -1); g.add(filterCap);

    // === Base Frame ===
    const frame = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 8), MAT.dark());
    frame.position.set(0, 0.15, 0);
    frame.receiveShadow = true;
    g.add(frame);

    // === Status LED Rings ===
    const glowMat = MAT.glow(COLORS.a2);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(5, 0.06, 16, 80), glowMat);
    r1.rotation.x = -Math.PI / 2; r1.position.y = 0.05; g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(5, 0.02, 8, 80), MAT.glow(COLORS.a2));
    r2.rotation.x = -Math.PI / 2; r2.position.y = 0.5; g.add(r2);

    assets.A2.group = g;
    assets.A2.glowParts = [glowMat, r2.material];
    g.position.set(0, 5, 0);
    scene.add(g);
}

// =====================================================================
//  A3 — APU COMPRESSOR / TURBINE (Detailed)
// =====================================================================
function buildA3() {
    const g = new THREE.Group();

    // === Main Turbine Housing (horizontal cylinder) ===
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.0, 7, 32), MAT.body());
    housing.rotation.z = Math.PI / 2;
    housing.position.set(0, 2.5, 0);
    housing.castShadow = true; housing.receiveShadow = true;
    g.add(housing);

    // === Air Intake Cone (left side) ===
    const intake = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.5, 32), MAT.panel());
    intake.rotation.z = Math.PI / 2;
    intake.position.set(-4.2, 2.5, 0);
    g.add(intake);

    // Intake screen/grille
    const intakeRing = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.1, 8, 32), MAT.chrome());
    intakeRing.rotation.y = Math.PI / 2;
    intakeRing.position.set(-4.9, 2.5, 0);
    g.add(intakeRing);

    // Intake vanes
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        const vane = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.6, 0.15), MAT.chrome());
        vane.position.set(-4.85, 2.5, 0);
        vane.rotation.x = a;
        g.add(vane);
    }

    // === Exhaust Section (right side) ===
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 1.5, 32), MAT.dark());
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(4.2, 2.5, 0);
    g.add(exhaust);

    // Exhaust nozzle ring
    const nozzleRing = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.08, 8, 32), MAT.glow(0x331100));
    nozzleRing.rotation.y = Math.PI / 2;
    nozzleRing.position.set(4.95, 2.5, 0);
    g.add(nozzleRing);

    // === Compressor Stages (visible rings along housing) ===
    for (let x = -2.5; x <= 2.5; x += 1) {
        const stageRing = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.08, 16, 32), MAT.panel());
        stageRing.rotation.y = Math.PI / 2;
        stageRing.position.set(x, 2.5, 0);
        g.add(stageRing);
    }

    // === Accessory Gearbox (bottom) ===
    const gearbox = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 2.5), MAT.panel());
    gearbox.position.set(0, 0.8, -1.8);
    gearbox.castShadow = true;
    g.add(gearbox);

    // Generator (cylinder on gearbox)
    const gen = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.5, 20), MAT.dark());
    gen.rotation.z = Math.PI / 2;
    gen.position.set(0, 1.8, -2.8);
    g.add(gen);

    // === Oil Lines ===
    const oilPath = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(-1.0, 0.5, -0.8),
            new THREE.Vector3(-1.5, 0.3, 0),
            new THREE.Vector3(-1.0, 0.5, 0.8),
        ]), 20, 0.08, 8, false
    );
    g.add(new THREE.Mesh(oilPath, MAT.pipe(0x556633)));

    // === Mounting Bolts ===
    for (const [x, z] of [[-2.5, 2], [2.5, 2], [-2.5, -2], [2.5, -2]]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.2, 8), MAT.chrome());
        bolt.position.set(x, 0.1, z); g.add(bolt);
    }

    // === Cooling Fins (top) ===
    for (let x = -2; x <= 2; x += 0.4) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 3), MAT.panel());
        fin.position.set(x, 4.5, 0); g.add(fin);
    }

    // === Base Frame ===
    const frame = new THREE.Mesh(new THREE.BoxGeometry(10, 0.3, 7), MAT.dark());
    frame.position.set(0, 0.15, 0);
    frame.receiveShadow = true;
    g.add(frame);

    // === Status LED Rings ===
    const glowMat = MAT.glow(COLORS.a3);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.06, 16, 80), glowMat);
    r1.rotation.x = -Math.PI / 2; r1.position.y = 0.05; g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.02, 8, 80), MAT.glow(COLORS.a3));
    r2.rotation.x = -Math.PI / 2; r2.position.y = 0.5; g.add(r2);

    assets.A3.group = g;
    assets.A3.glowParts = [glowMat, r2.material];
    g.position.set(20, 5, 0);
    scene.add(g);
}

// Build all
buildA1();
buildA2();
buildA3();

// =====================================================================
//  ANIMATION
// =====================================================================
const clock = new THREE.Clock();
let a3Vibration = 0;

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    controls.update();
    particles.rotation.y = t * 0.03;

    // Pulsing glow
    const pulse = Math.sin(t * 2.5) * 0.15 + 0.85;
    for (const id of ['A1', 'A2', 'A3']) {
        assets[id].glowParts.forEach(m => { m.emissiveIntensity = pulse; });
    }

    // A3 vibration
    if (a3Vibration > 0) {
        assets.A3.group.position.x = 20 + (Math.random() - 0.5) * a3Vibration;
        assets.A3.group.position.z = (Math.random() - 0.5) * a3Vibration;
    } else {
        assets.A3.group.position.x = 20;
        assets.A3.group.position.z = 0;
    }

    composer.render();
}
animate();

// Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// =====================================================================
//  MQTT CONNECTION
// =====================================================================
const mqttBadge = document.getElementById('mqtt-status');
const mqttDot   = mqttBadge.querySelector('.conn-dot');
const mqttText  = mqttBadge.querySelector('.conn-text');
let msgCount = 0;
const startTime = Date.now();
let client = null;

function buildClient() {
    client = new Paho.Client("127.0.0.1", 9001, "/", "jesa_twin_" + Math.random().toString(36).substring(2, 9));
    client.onConnectionLost = onConnectionLost;
    client.onMessageArrived = onMessageArrived;
}

function connectClient() {
    if (!client) buildClient();
    client.connect({
        onSuccess: onConnect,
        onFailure: onFailure,
        reconnect: true,
        keepAliveInterval: 30,
    });
}

buildClient();
connectClient();

function onConnect() {
        console.log('%c✓ MQTT Connected', 'color:#00e676;font-weight:bold');
        mqttBadge.className = 'conn-badge live';
        mqttText.textContent = 'Live';
        _logEvent('MQTT broker connected', 'info');

        client.subscribe('jesa/site1/workshop/milling/A1/#');
        client.subscribe('jesa/site1/workshop/hydraulics/A2/#');
        client.subscribe('jesa/site1/fleet/apu/A3/#');
    }

function onFailure(err) {
    console.error('MQTT failed:', err.errorMessage);
    mqttBadge.className = 'conn-badge offline';
    mqttText.textContent = 'Offline';
    _logEvent('MQTT connection failed: ' + err.errorMessage, 'critical');
}

function onConnectionLost(resp) {
    if (resp.errorCode !== 0) {
        console.warn('MQTT lost:', resp.errorMessage);
        mqttBadge.className = 'conn-badge offline';
        mqttText.textContent = 'Offline';
        _logEvent('MQTT connection lost', 'warning');
    }
}

// =====================================================================
//  HELPER UI FUNCTIONS
// =====================================================================
function setChip(id, text, cls) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'status-chip ' + cls;
}

function setCardGlow(cardId, cls) {
    const el = document.getElementById(cardId);
    el.className = 'asset-card ' + cls;
}

function setAssetGlow(assetId, colorHex) {
    assets[assetId].glowParts.forEach(m => {
        m.color.setHex(colorHex);
        m.emissive.setHex(colorHex);
    });
}

function markAssetSeen(assetId) {
    const entry = assetTelemetry[assetId];
    entry.lastSeen = Date.now();
    entry.updates += 1;
}

function formatLastSeen(assetId) {
    const lastSeen = assetTelemetry[assetId].lastSeen;
    if (!lastSeen) return 'Waiting for data';
    const ageSec = Math.max(0, Math.floor((Date.now() - lastSeen) / 1000));
    return ageSec === 0 ? 'just now' : `${ageSec}s ago`;
}

function refreshTelemetryHealth() {
    let online = 0;
    for (const assetId of ['A1', 'A2', 'A3']) {
        const age = assetTelemetry[assetId].lastSeen ? Date.now() - assetTelemetry[assetId].lastSeen : Infinity;
        document.getElementById(`${assetId.toLowerCase()}-last`).textContent = formatLastSeen(assetId);
        if (age <= STALE_MS[assetId]) {
            online += 1;
        } else if (assetTelemetry[assetId].updates > 0) {
            setChip(`${assetId.toLowerCase()}-chip`, 'Stale', 'warning');
            setCardGlow(`card-${assetId.toLowerCase()}`, 'asset-card warning-glow');
        }
    }
    document.getElementById('assets-online').textContent = `${online}/3`;
}

function resetCamera() {
    // If scene was physically lifted, bring it back down
    if (sceneLiftedCount > 0) {
        _applyPanelLift(-PANEL_LIFT * sceneLiftedCount);
        sceneLiftedCount = 0;
        panelLiftActive = false;
    }
    controls.autoRotate = true;
    controls.target.set(0, 4, 0);
    camera.position.set(0, 18, 50);
    document.querySelectorAll('.asset-card').forEach(c => c.style.outline = 'none');
}

// Uptime timer
setInterval(() => {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    document.getElementById('uptime').textContent = m + ':' + s;
}, 1000);

// Refresh overview KPIs every second when on that page
setInterval(() => {
    if (currentPage === 'overview') _refreshOverviewDynamic();
}, 1000);

setInterval(refreshTelemetryHealth, 2000);

// =====================================================================
//  RENDER TICKER — 30 fps, fully decoupled from MQTT arrival rate
//  All visual updates (charts, KPI numbers, detail panel) happen here.
//  MQTT onMessageArrived only writes to ring buffers — never redraws.
// =====================================================================
let _renderLastTs = 0;
const RENDER_FPS   = 30;
const RENDER_FRAME = 1000 / RENDER_FPS;   // ~33 ms

// Throttled Chart.js update — only call .update() when data actually changed
let _vizDirty = false;   // set true by _vizPush; cleared after Chart.js update

// Wrap _vizPush to mark dirty flag
const _vizPushOrig = _vizPush;
// (no override needed — we just check buffers directly)

function _renderTick(ts) {
    requestAnimationFrame(_renderTick);
    if (ts - _renderLastTs < RENDER_FRAME) return;
    _renderLastTs = ts;

    // ── Visualisation page ─────────────────────────────────────────
    if (currentPage === 'visualisation') {
        _vizRefreshCharts();
    }

    // ── Analytics page ─────────────────────────────────────────────
    if (currentPage === 'analytics') {
        _refreshAnalyticsDynamic();
    }

    // ── Detail panel (any page) ────────────────────────────────────
    if (_currentDetailAsset && _dsbCurrent) {
        // Redraw canvas charts at 30fps for smooth hover + live data
        for (const c of _dsbCurrent.charts) c.render();
        // Refresh chips/tiles at ~5fps (every 6th frame) to avoid DOM thrash
        if (Math.round(ts / RENDER_FRAME) % 6 === 0) {
            refreshDetailPanel();
        }
    }
}
requestAnimationFrame(_renderTick);
//  MESSAGE HANDLER
// =====================================================================
function onMessageArrived(message) {
    const topic = message.destinationName;
    msgCount++;
    document.getElementById('msg-count').textContent = msgCount.toLocaleString();

    try {
        const payload = JSON.parse(message.payloadString);
        const v = payload.v;

        // Mark any asset as seen when we get any of its topics
        if (topic.includes('/A1/')) markAssetSeen('A1');
        if (topic.includes('/A2/')) markAssetSeen('A2');
        if (topic.includes('/A3/')) markAssetSeen('A3');

        // ── Dashboard ring buffers — feed from every UNS topic ──
        // Guard: skip stale (v === null) and non-numeric string values
        // Exception: source_timestamp is a string — route it directly to dsbLatest
        try {
            if (v !== null && v !== undefined && payload.q !== 'stale') {
                if (typeof v === 'string' && topic.includes('/simulation/source_timestamp')) {
                    // String value — write directly to dsbLatest, skip numeric ring buffer
                    const m2 = topic.match(/\/(A[123])\/(.+)$/);
                    if (m2) {
                        const [, aId, rest2] = m2;
                        const dk = _dsbUnsToKey[`${aId}@${rest2}`];
                        if (dk) dsbLatest[aId][dk] = v;
                    }
                } else {
                    const num = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
                    if (!Number.isNaN(num)) _dsbRouteTopic(topic, num);
                }
            }
        } catch (_) { /* ignore routing failures for analytics-only topics */ }

        // ── Per-asset timing indicators — always update, independent of main chain ──
        if (topic.includes('/A1/tool/tool_wear_min')) {
            const el = document.getElementById('a1-tool-wear');
            if (el) el.textContent = Number(v).toFixed(0) + ' min';
        }
        if (topic.includes('/A1/simulation/part_index')) {
            const el = document.getElementById('a1-part-index');
            if (el) el.textContent = '#' + Number(v).toLocaleString('en-US');
        }
        if (topic.includes('/A2/simulation/cycle_index')) {
            const el = document.getElementById('a2-cycle-index');
            if (el) el.textContent = Number(v) + ' / 2205';
            // Also mark started if cycle has advanced past 0
            if (Number(v) > 0) _a2SimStarted = true;
        }
        if (topic.includes('/A2/simulation/cycle_second')) {
            const sec = Number(v);
            const el = document.getElementById('a2-cycle-second');
            if (el) el.textContent = sec + ' / 59 s';
            // Drive the cycle progress bar (0–59 → 0–100%)
            const bar = document.getElementById('a2-cycle-bar');
            if (bar) bar.style.width = Math.round((sec / 59) * 100) + '%';
            // Mark sim as started once second has advanced past 0
            if (sec > 0 || _a2SimStarted) _a2SimStarted = true;
        }
        if (topic.includes('/A3/simulation/source_timestamp') && v) {
            const el = document.getElementById('a3-dataset-ts');
            if (el) el.textContent = String(v).replace('T', ' ').slice(0, 19);
        }
        if (topic.includes('/A3/simulation/row_index')) {
            // row index element removed from UI
        }

        // ── A1 Milling ──
        if (topic.includes('/A1/analytics/machine_failure') || topic.includes('/A1/status/machine_failure')) {
            if (v === null || v === undefined || payload.q === 'stale') return;

            const failureProbability = payload.probability ?? ((v === 1 || v === true) ? 1 : 0);
            const probVal = Number(failureProbability) * 100;
            const prob    = probVal.toFixed(1);
            document.getElementById('a1-prob').textContent = prob + '%';
            document.getElementById('a1-bar').style.width  = probVal.toFixed(1) + '%';

            // Three-level state: critical (>20% or binary failure) / warning (5–20%) / healthy
            const isFailure  = (v === 1 || v === true);
            const newState   = (isFailure || probVal > 20) ? 'critical'
                             : probVal > 5                 ? 'warning'
                             :                               'healthy';
            const stateChanged = newState !== _a1PrevState;
            _a1PrevState = newState;

            if (newState === 'critical') {
                document.getElementById('a1-status').textContent  = isFailure ? 'FAILURE' : 'CRITICAL';
                document.getElementById('a1-status').className    = 'gauge-value critical';
                document.getElementById('a1-prob').className      = 'gauge-value mono critical';
                document.getElementById('a1-bar').style.background = 'linear-gradient(90deg,#ff1744,#ff5252)';
                setChip('a1-chip', 'Critical', 'critical');
                setCardGlow('card-a1', 'asset-card critical-glow');
                setAssetGlow('A1', COLORS.critical);
                if (stateChanged)
                    _logEvent(`A1 — ${isFailure ? 'FAILURE' : 'Critical'} (prob: ${prob}%)`, 'critical');
            } else if (newState === 'warning') {
                document.getElementById('a1-status').textContent  = 'WARNING';
                document.getElementById('a1-status').className    = 'gauge-value warning';
                document.getElementById('a1-prob').className      = 'gauge-value mono warning';
                document.getElementById('a1-bar').style.background = 'linear-gradient(90deg,var(--accent-amber),#fbbf24)';
                setChip('a1-chip', 'Warning', 'warning');
                setCardGlow('card-a1', 'asset-card warning-glow');
                setAssetGlow('A1', COLORS.warning);
                if (stateChanged)
                    _logEvent(`A1 — Warning (prob: ${prob}%)`, 'warning');
            } else {
                document.getElementById('a1-status').textContent  = 'HEALTHY';
                document.getElementById('a1-status').className    = 'gauge-value good';
                document.getElementById('a1-prob').className      = 'gauge-value mono';
                document.getElementById('a1-bar').style.background = 'linear-gradient(90deg,var(--a1-color),#6c9bff)';
                setChip('a1-chip', 'Healthy', 'healthy');
                setCardGlow('card-a1', 'asset-card healthy-glow');
                setAssetGlow('A1', COLORS.good);
                if (stateChanged)
                    _logEvent(`A1 — Healthy (prob: ${prob}%)`, 'info');
            }
            _vizPush(vizData.A1.failureProb, probVal);
            _vizPush(vizData.A1.timestamps,  _vizTimestamp());
        }

        // ── A2 Hydraulics ──
        // ZeMA dataset classes:
        //   cooler: 100=full, 20=partial, 3=near-failure, 0=failed
        //   valve:  100=optimal, 90=small lag, 80=severe lag, 73=close to total failure
        //   pump:   0=no leak, 1=weak leak, 2=severe leak
        //   accum.: 130=optimal, 115=slightly reduced, 100=severely reduced, 90=close to failure
        else if (topic.includes('/A2/analytics/cooler_condition') ||
                 topic.includes('/A2/condition/cooler_condition_pct')) {
            // Guard: skip null, stale, or uninitialized OPC UA default values
            if (v === null || v === undefined || payload.q === 'stale') return;
            // Block condition/ OPC UA topics until sim loop has advanced (cycle_second > 0)
            // The OPC UA Tag default is 0 — shown as "Failed" before real data arrives
            if (topic.includes('/A2/condition/') && (!_a2SimStarted || v === 0)) return;
            if (topic.includes('/A2/analytics/')) _a2LastAnalyticsTs = Date.now();

            const coolerMap = {
                100: { pct: 100, txt: 'Optimal',      cls: 'healthy'  },
                 20: { pct:  60, txt: 'Partial',      cls: 'warning'  },
                  3: { pct:  20, txt: 'Near-Failure', cls: 'critical' },
                  0: { pct:   0, txt: 'Failed',       cls: 'critical' },
            };
            const cm = coolerMap[v] ?? { pct: 0, txt: `Class ${v}`, cls: 'warning' };

            document.getElementById('a2-cooler').textContent = cm.txt + ' (class ' + v + ')';
            document.getElementById('a2-cooler').className   = 'gauge-value ' + cm.cls;
            document.getElementById('a2-bar').style.width    = cm.pct + '%';

            // Update worst-case tracker and drive chip/glow
            _a2State.cooler = cm.cls;
            _a2ApplyChip();

            if (topic.includes('/A2/analytics/'))
                _logEvent(`A2 — Cooler: ${cm.txt} (class ${v})`, cm.cls === 'healthy' ? 'info' : cm.cls);

            a2LatestLabels.cooler = `${cm.txt} (${cm.pct}%)`;
            if (topic.includes('/A2/analytics/')) {
                _vizPush(vizData.A2.cooler,     cm.pct);
                _vizPush(vizData.A2.timestamps, _vizTimestamp());
            }
        }
        else if (topic.includes('/A2/analytics/valve_condition') ||
                 topic.includes('/A2/condition/valve_condition_pct')) {
            // Class 0 never valid for valve (valid: 100, 90, 80, 73)
            // Also block condition/ until sim loop has started
            if (v === null || v === undefined || payload.q === 'stale' || v === 0) return;
            if (topic.includes('/A2/condition/') && !_a2SimStarted) return;

            const valveMap = {
                100: { pct: 100, txt: 'Optimal',      cls: 'healthy'  },
                 90: { pct:  85, txt: 'Small lag',    cls: 'warning'  },
                 80: { pct:  50, txt: 'Severe lag',   cls: 'warning'  },
                 73: { pct:  20, txt: 'Near-failure', cls: 'critical' },
            };
            const vm = valveMap[v] ?? { pct: Math.min(Number(v), 100), txt: `Class ${v}`, cls: 'warning' };

            document.getElementById('a2-valve').textContent = vm.txt + ' (class ' + v + ')';
            document.getElementById('a2-valve').className   = 'gauge-value mono ' + vm.cls;

            // Update worst-case tracker and drive chip/glow
            _a2State.valve = vm.cls;
            _a2ApplyChip();

            if (topic.includes('/A2/analytics/'))
                _logEvent(`A2 — Valve: ${vm.txt} (class ${v})`, vm.cls === 'healthy' ? 'info' : vm.cls);

            a2LatestLabels.valve = `${vm.txt} (${vm.pct}%)`;
            if (topic.includes('/A2/analytics/'))
                _vizPush(vizData.A2.valve, vm.pct);
        }
        else if (topic.includes('/A2/analytics/pump_leakage') ||
                 topic.includes('/A2/condition/pump_leakage')) {
            if (v === null || v === undefined || payload.q === 'stale') return;
            if (topic.includes('/A2/condition/') && !_a2SimStarted) return;
            const pumpMap = {
                0: { txt: 'No leak',     cls: 'healthy'  },
                1: { txt: 'Weak leak',   cls: 'warning'  },
                2: { txt: 'Severe leak', cls: 'critical' },
            };
            const pm = pumpMap[v] ?? { txt: `Class ${v}`, cls: 'warning' };
            _a2State.pump = pm.cls;
            _a2ApplyChip();
            if (topic.includes('/A2/analytics/'))
                _logEvent(`A2 — Pump: ${pm.txt} (class ${v})`, pm.cls === 'healthy' ? 'info' : pm.cls);
        }
        else if (topic.includes('/A2/analytics/accumulator_pressure') ||
                 topic.includes('/A2/condition/accumulator_pressure_bar')) {
            if (v === null || v === undefined || payload.q === 'stale') return;
            if (topic.includes('/A2/condition/') && !_a2SimStarted) return;
            const accMap = {
                130: { txt: 'Optimal',           cls: 'healthy'  },
                115: { txt: 'Slightly reduced',  cls: 'warning'  },
                100: { txt: 'Severely reduced',  cls: 'critical' },
                 90: { txt: 'Near-failure',       cls: 'critical' },
            };
            const am = accMap[v] ?? { txt: `Class ${v}`, cls: 'warning' };
            _a2State.accum = am.cls;
            _a2ApplyChip();
            if (topic.includes('/A2/analytics/'))
                _logEvent(`A2 — Accumulator: ${am.txt} (class ${v})`, am.cls === 'healthy' ? 'info' : am.cls);
        }

        // ── A3 APU Compressor ──
        else if (topic.includes('/A3/analytics/anomaly')) {
            const prevAnalyticsTs    = _a3.lastAnalyticsTs;
            _a3.lastAnalyticsTs      = Date.now();

            const rawScore  = payload.score != null ? +payload.score : 0;
            const scoreStr  = rawScore.toFixed(3);
            document.getElementById('a3-score').textContent       = scoreStr;
            document.getElementById('a3-bar').style.width         = Math.min(rawScore * 100, 100) + '%';

            // ── Hysteresis counters ────────────────────────────────
            if (rawScore > _a3.SEUIL_HAUT) {
                _a3.anomalyStreakHi = Math.min(_a3.anomalyStreakHi + 1, _a3.STREAK_CONFIRM + 1);
                _a3.anomalyStreakLo = 0;
            } else if (rawScore <= _a3.SEUIL_BAS) {
                _a3.anomalyStreakLo = Math.min(_a3.anomalyStreakLo + 1, _a3.STREAK_CONFIRM + 1);
                _a3.anomalyStreakHi = 0;
            }
            // else: score in hysteresis band → counters unchanged

            // ── Stale guard: was the previous prediction too long ago? ──
            // Use prevAnalyticsTs (before update) — if gap > STALE_MS block critical
            const gapSinceLastPred = prevAnalyticsTs > 0 ? (Date.now() - prevAnalyticsTs) : 0;
            const allowCritical    = prevAnalyticsTs === 0 || gapSinceLastPred < STALE_MS.A3;

            // ── State machine ──────────────────────────────────────
            let nextState = _a3.state;
            if (_a3.anomalyStreakHi >= _a3.STREAK_CONFIRM && allowCritical) {
                nextState = 'critical';
            } else if (rawScore > _a3.SEUIL_HAUT && allowCritical && _a3.state === 'critical') {
                nextState = 'critical'; // stay critical while score above threshold
            } else if (rawScore > (_a3.SEUIL_BAS + 0.05) && allowCritical) {
                // Warning band: SEUIL_BAS+0.05 (0.45) → SEUIL_HAUT (0.50)
                // Also warns when coming down from critical before streak confirms healthy
                if (_a3.state !== 'critical') nextState = 'warning';
                else nextState = 'warning'; // step-down from critical
            } else if (_a3.anomalyStreakLo >= _a3.STREAK_CONFIRM) {
                nextState = 'healthy';
            } else if (_a3.state === 'critical' && rawScore <= _a3.SEUIL_BAS) {
                nextState = 'warning'; // soft step-down, not instant healthy
            }
            const _a3StateChanged = nextState !== _a3.state;
            _a3.state = nextState;

            // ── UI update ─────────────────────────────────────────
            const barGrad = _a3.state === 'critical'
                ? 'linear-gradient(90deg, #ff1744, #ff5252)'
                : _a3.state === 'warning'
                    ? 'linear-gradient(90deg, var(--accent-amber), #fbbf24)'
                    : 'linear-gradient(90deg, var(--a3-color), #a78bfa)';
            document.getElementById('a3-bar').style.background = barGrad;

            if (_a3.state === 'critical') {
                document.getElementById('a3-status').textContent = 'ANOMALY';
                document.getElementById('a3-status').className   = 'gauge-value critical';
                document.getElementById('a3-score').className    = 'gauge-value mono critical';
                setChip('a3-chip', 'Anomaly', 'critical');
                setCardGlow('card-a3', 'asset-card critical-glow');
                setAssetGlow('A3', COLORS.critical);
                a3Vibration = 0.4;
                if (_a3StateChanged)
                    _logEvent(`A3 — ANOMALY (score=${scoreStr}, streak=${_a3.anomalyStreakHi})`, 'critical');
            } else if (_a3.state === 'warning') {
                document.getElementById('a3-status').textContent = 'WATCH';
                document.getElementById('a3-status').className   = 'gauge-value warning';
                document.getElementById('a3-score').className    = 'gauge-value mono warning';
                setChip('a3-chip', 'Watch', 'warning');
                setCardGlow('card-a3', 'asset-card warning-glow');
                setAssetGlow('A3', COLORS.warning);
                a3Vibration = 0.15;
                if (_a3StateChanged)
                    _logEvent(`A3 — Watch (score=${scoreStr})`, 'warning');
            } else {
                document.getElementById('a3-status').textContent = 'NORMAL';
                document.getElementById('a3-status').className   = 'gauge-value good';
                document.getElementById('a3-score').className    = 'gauge-value mono';
                setChip('a3-chip', 'Normal', 'healthy');
                setCardGlow('card-a3', 'asset-card healthy-glow');
                setAssetGlow('A3', COLORS.good);
                a3Vibration = 0;
                if (_a3StateChanged)
                    _logEvent(`A3 — Normal (score=${scoreStr})`, 'info');
            }
            // ── Viz ring buffer push ──
            _vizPush(vizData.A3.anomalyScore, rawScore);
            _vizPush(vizData.A3.timestamps,   _vizTimestamp());
        }

        // ── Derived Metrics & Card Gauges ──
        else if (topic.includes('/A1/derived/power_kw')) {
            const el = document.getElementById('a1-power');
            if (el) el.textContent = Number(v).toFixed(2) + ' kW';
        }
        else if (topic.includes('/A2/derived/cooler_delta_t_c')) {
            const el = document.getElementById('a2-dt');
            if (el) el.textContent = Number(v).toFixed(1) + ' °C';
        }
        else if (topic.includes('/A3/derived/comp_duty_pct_5min')) {
            const el = document.getElementById('a3-comp-duty');
            if (el) el.textContent = Number(v).toFixed(1) + '%';
        }
        else if (topic.includes('/A3/digital/comp')) {
            const el = document.getElementById('a3-load-state');
            if (el) {
                const isLoaded = (v === true || v === 1);
                el.textContent = isLoaded ? 'LOADED' : 'UNLOADED';
                el.className = 'gauge-value mono ' + (isLoaded ? 'good' : 'warning');
            }
        }
        else if (topic.includes('/plc/system/active_alarms')) {
            try {
                const activeList = Array.isArray(v) ? v : (typeof payload === 'object' && Array.isArray(payload.active) ? payload.active : []);
                const a1Count = activeList.filter(a => String(a).startsWith('A1/')).length;
                const a2Count = activeList.filter(a => String(a).startsWith('A2/')).length;
                const a3Count = activeList.filter(a => String(a).startsWith('A3/')).length;
                const totalCount = a1Count + a2Count + a3Count;

                const e1 = document.getElementById('a1-alarms');
                if (e1) { e1.textContent = a1Count; e1.style.color = a1Count > 0 ? 'var(--accent-red)' : 'var(--accent-green)'; }

                const e2 = document.getElementById('a2-alarms');
                if (e2) { e2.textContent = a2Count; e2.style.color = a2Count > 0 ? 'var(--accent-red)' : 'var(--accent-green)'; }

                const e3 = document.getElementById('a3-alarms');
                if (e3) { e3.textContent = a3Count; e3.style.color = a3Count > 0 ? 'var(--accent-red)' : 'var(--accent-green)'; }

                // Global alarms counter (top bar)
                const eg = document.getElementById('global-alarms-count');
                if (eg) { eg.textContent = totalCount; eg.style.color = totalCount > 0 ? 'var(--accent-red)' : 'var(--accent-green)'; }
            } catch (_) {}
        }

        // ── A1 per-mode predictions — update detail panel if open ──
        // NOTE: no immediate redraws here — the 30fps render ticker handles all
        // visual updates continuously, decoupled from MQTT arrival rate.

    } catch (e) {
        console.error('Parse error:', e);
    }
}

// =====================================================================
//  CLICK TO FOCUS (orbit to clicked asset)
// =====================================================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

renderer.domElement.addEventListener('click', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    for (const [id, asset] of Object.entries(assets)) {
        if (!asset.group) continue;
        const hits = raycaster.intersectObjects(asset.group.children, true);
        if (hits.length > 0) {
            controls.autoRotate = false;
            const pos = asset.group.position;

            // Highlight corresponding card
            document.querySelectorAll('.asset-card').forEach(c => c.style.outline = 'none');
            const card = document.getElementById('card-' + id.toLowerCase());
            card.style.outline = '1px solid rgba(0,229,255,0.4)';
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            // Open detail panel first — this calls raisePanelScene() which shifts pos.y by +PANEL_LIFT
            openAssetDetail(id);

            // Point camera at the raised asset position
            const raisedY = pos.y; // pos.y already updated by raisePanelScene
            controls.target.set(pos.x, raisedY , pos.z);
            camera.position.set(pos.x + 8, raisedY + 5, pos.z + 30);

            setTimeout(() => { controls.autoRotate = true; }, 8000);
            break;
        }
    }
});

// Card click → focus 3D asset
document.querySelectorAll('.asset-card').forEach(card => {
    card.addEventListener('click', () => {
        const id = card.dataset.asset;
        if (!assets[id] || !assets[id].group) return;
        controls.autoRotate = false;
        const pos = assets[id].group.position;

        // Open detail panel first — this calls raisePanelScene() which shifts pos.y by +PANEL_LIFT
        openAssetDetail(id);

        // Point camera at the raised asset position
        const raisedY = pos.y; // pos.y already updated by raisePanelScene
        controls.target.set(pos.x, raisedY , pos.z);
        camera.position.set(pos.x + 8, raisedY + 5, pos.z + 30);
        
        setTimeout(() => { controls.autoRotate = true; }, 8000);
    });
});

document.getElementById('reset-view').addEventListener('click', resetCamera);
document.getElementById('reconnect-mqtt').addEventListener('click', () => {
    mqttBadge.className = 'conn-badge';
    mqttText.textContent = 'Reconnecting';
    try {
        client.disconnect();
    } catch (_) {
        // Best-effort disconnect before rebuilding the socket client.
    }
    buildClient();
    connectClient();
});

// Initialize navigation
initNavigation();

// =====================================================================
//  THEME TOGGLE — Dark / Light mode
//  Placed after scene + ground + _vizCharts are all defined.
// =====================================================================
(function initTheme() {
    const STORAGE_KEY = 'jesa-theme';
    const root        = document.documentElement;
    const btn         = document.getElementById('theme-toggle');

    function applyTheme(theme) {
        // 1. Drive every CSS variable on the page
        root.setAttribute('data-theme', theme);

        const isDark = theme === 'dark';

        // 2. Three.js — scene background + fog + ground
        scene.background.set(isDark ? 0x0f172a : 0xf5f0e8);
        if (scene.fog) {
            scene.fog.color.set(isDark ? 0x0f172a : 0xf5f0e8);
            scene.fog.density = isDark ? 0.008 : 0.004;
        }
        if (ground) {
            ground.material.color.set(isDark ? 0x0f172a : 0xe8e0d0); // beige sol
            ground.material.roughness = isDark ? 0.85 : 0.95;
        }
        if (grid) grid.material.opacity = isDark ? 0.12 : 0.18;

        // Bloom off in light mode
        bloom.strength           = isDark ? 0.7  : 0.0;
        bloom.threshold          = isDark ? 0.35 : 1.0;
        renderer.toneMappingExposure = isDark ? 1.1 : 1.0;

        // 3. Recolor all registered materials — precise 1:1 mapping, no guessing
        for (const { mat, darkColor, lightColor } of _allMaterials) {
            mat.color.set(isDark ? darkColor : lightColor);
        }

        // 4. Lighting
        scene.traverse(obj => {
            if (obj.isAmbientLight)     obj.intensity = isDark ? 1.2 : 4.0;
            if (obj.isDirectionalLight) obj.intensity = isDark ? 2.5 : 3.5;
            if (obj.isPointLight)       obj.intensity = isDark ? (obj._base ?? obj.intensity) : 0.3;
            if (obj.isPointLight && obj._base === undefined) obj._base = obj.intensity;
        });

        // 5. Chart.js — update tick/grid colors on any live charts
        const tickColor = isDark ? '#64748b' : '#94a3b8';
        const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
        Object.values(_vizCharts).forEach(chart => {
            ['x', 'y'].forEach(axis => {
                if (chart.options.scales[axis]) {
                    chart.options.scales[axis].ticks.color = tickColor;
                    chart.options.scales[axis].grid.color  = gridColor;
                }
            });
            chart.update('none');
        });
    }

    function toggle() {
        const current = root.getAttribute('data-theme') || 'dark';
        const next    = current === 'dark' ? 'light' : 'dark';
        localStorage.setItem(STORAGE_KEY, next);
        applyTheme(next);
    }

    // Boot: saved preference → OS preference → dark
    const saved  = localStorage.getItem(STORAGE_KEY);
    const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved ?? (osDark ? 'dark' : 'light'));

    // Sync if OS theme changes and user has no saved preference
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (!localStorage.getItem(STORAGE_KEY)) applyTheme(e.matches ? 'dark' : 'light');
    });

    btn.addEventListener('click', toggle);
})();

// Initialize asset detail panel handlers
document.getElementById('close-detail-panel').addEventListener('click', closeAssetDetail);
document.getElementById('asset-detail-overlay').addEventListener('click', closeAssetDetail);
