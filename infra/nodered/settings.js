/**
 * JESA Digital Twin — Node-RED Runtime Settings
 * Used by the jesa-nodered Docker container (Node 18 / Dockerfile.nodered).
 */

module.exports = {

    // ── Runtime ────────────────────────────────────────────────────────────
    flowFile:         'flows.json',
    flowFilePretty:   true,
    credentialSecret: 'jesa-dev-secret',

    // ── HTTP server ────────────────────────────────────────────────────────
    uiPort: 1880,
    uiHost: '0.0.0.0',

    disableEditor: false,

    // ── Context storage ────────────────────────────────────────────────────
    contextStorage: {
        default:    { module: 'memory' },
        persistent: { module: 'localfilesystem' },
    },

    // ── Logging ────────────────────────────────────────────────────────────
    logging: {
        console: {
            level:  'info',
            metric: false,
            audit:  false,
        },
    },

    // ── Editor theme ───────────────────────────────────────────────────────
    editorTheme: {
        page:    { title: 'JESA Digital Twin — Derived Data & Alarms' },
        header:  { title: 'JESA UNS' },
        projects: { enabled: false },
        codeEditor: { lib: 'monaco' },
    },

    // ── Directories ─────────────────────────────────────────────────────────
    // /data is the container's work dir (flows.json, context, credentials).
    // Nodes are in /data/custom_modules/node_modules (pre-installed in volume).
    userDir:  '/data',

    // ── Function node global context ───────────────────────────────────────
    functionGlobalContext: {
        TOPIC_PREFIX:    'jesa/site1',
        MQTT_BROKER_URL: 'mqtt://mosquitto:1883',
        ASSETS: {
            A1:  { area: 'workshop/milling',    url: 'opc.tcp://host.docker.internal:4841/jesa/a1',  ns: 'urn:jesa:sim:a1' },
            A2:  { area: 'workshop/hydraulics', url: 'opc.tcp://host.docker.internal:4842/jesa/a2',  ns: 'urn:jesa:sim:a2' },
            A3:  { area: 'fleet/apu',           url: 'opc.tcp://host.docker.internal:4843/jesa/a3',  ns: 'urn:jesa:sim:a3' },
            PLC: { area: 'plc',                 url: 'opc.tcp://host.docker.internal:4840/jesa/plc', ns: 'urn:jesa:plc'    },
        },
        ALARM_LIMITS: {
            'workshop/milling/A1/drive/torque_nm':            { LL:   3, L:  10, H:  60,  HH:  70,  unit: 'Nm'   },
            'workshop/milling/A1/drive/rotational_speed_rpm': { LL: 800, L:1200, H:2500,  HH:2900,  unit: 'rpm'  },
            'workshop/milling/A1/tool/tool_wear_min':         { LL:null, L:null, H: 200,  HH: 240,  unit: 'min'  },
            'workshop/milling/A1/derived/power_kw':           { LL: 3.5, L:null, H:null,  HH:  9.0, unit: 'kW'   },
            'workshop/hydraulics/A2/motor/power_w':           { LL:null, L:null, H:2900,  HH:3200,  unit: 'W'    },
            'workshop/hydraulics/A2/motor/vibration_mms':     { LL:null, L:null, H: 0.8,  HH:  1.2, unit: 'mm/s' },
            'workshop/hydraulics/A2/kpis/cooling_efficiency_pct': { LL:15, L:30, H:null, HH:null, unit: '%' },
            'fleet/apu/A3/pneumatic/tp3_bar':                 { LL: 6.5, L: 7.0, H:10.5, HH: 11.0, unit: 'bar'  },
            'fleet/apu/A3/pneumatic/reservoirs_bar':          { LL: 6.5, L: 7.0, H:10.5, HH: 11.0, unit: 'bar'  },
            'fleet/apu/A3/motor/current_a':                   { LL:null, L:null, H: 8.0,  HH:  8.5, unit: 'A'    },
            'fleet/apu/A3/oil/temperature_c':                 { LL:null, L:null, H:65.0,  HH: 70.0, unit: 'C'    },
        },
        ALARM_ON_DELAY:     2,
        ALARM_DEADBAND_PCT: 2.0,
    },

    // ── External modules ───────────────────────────────────────────────────
    functionExternalModules: true,

    // ── Node settings ──────────────────────────────────────────────────────
    debugMaxLength:      1000,
    mqttReconnectTime:   5000,
    socketReconnectTime: 10000,
    socketTimeout:       120000,

    externalModules: {
        autoInstall: false,
        palette:  { allowInstall: true },
        modules:  { allowInstall: true },
    },
};
