const counters = new Map();
const gauges = new Map();

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function keyFor(name, labels = {}) {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

export function inc(name, labels = {}, value = 1) {
  const key = keyFor(name, labels);
  counters.set(key, (counters.get(key) || 0) + value);
}

export function setGauge(name, labels = {}, value = 0) {
  gauges.set(keyFor(name, labels), value);
}

export function addGauge(name, labels = {}, delta = 1) {
  const key = keyFor(name, labels);
  gauges.set(key, (gauges.get(key) || 0) + delta);
}

export function renderPrometheus() {
  const lines = [];
  const counterNames = new Set();
  for (const key of counters.keys()) counterNames.add(key.split('{')[0]);
  for (const name of counterNames) {
    lines.push(`# TYPE ${name} counter`);
    for (const [key, value] of counters) {
      if (key === name || key.startsWith(`${name}{`)) lines.push(`${key} ${value}`);
    }
  }
  const gaugeNames = new Set();
  for (const key of gauges.keys()) gaugeNames.add(key.split('{')[0]);
  for (const name of gaugeNames) {
    lines.push(`# TYPE ${name} gauge`);
    for (const [key, value] of gauges) {
      if (key === name || key.startsWith(`${name}{`)) lines.push(`${key} ${value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetrics() {
  counters.clear();
  gauges.clear();
}
