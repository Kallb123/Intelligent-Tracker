import './style.css';
import { describeHealth, fetchHealth } from './health.js';

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  app.innerHTML = '<h1>Intelligent Tracker</h1><p id="health" class="pending">Checking API…</p>';
  const status = app.querySelector<HTMLElement>('#health');
  const result = await fetchHealth();
  if (status) {
    status.textContent = describeHealth(result);
    status.className = result.ok ? 'ok' : 'error';
  }
}
