import { setupReachabilityViewer } from './reachability.js?v=20261023-attention-1';

setupReachabilityViewer();

function activateTab(group, panelId) {
  for (const tab of group.querySelectorAll('[role="tab"]')) {
    const active = tab.getAttribute('aria-controls') === panelId;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.parentElement.classList.toggle('is-active', active);
  }
  for (const panel of group.querySelectorAll('[role="tabpanel"]')) {
    panel.hidden = panel.id !== panelId;
  }
}

for (const group of document.querySelectorAll('[data-tab-group]')) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', event => {
      event.preventDefault();
      activateTab(group, tab.getAttribute('aria-controls'));
    });
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(group, tabs[next].getAttribute('aria-controls'));
      tabs[next].focus();
    });
  }
}

function revealResultTarget() {
  let target;
  try {
    target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  } catch {
    return;
  }
  const panel = target?.closest('[role="tabpanel"]');
  const group = panel?.closest('[data-tab-group]');
  if (!group) return;
  activateTab(group, panel.id);
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

window.addEventListener('hashchange', revealResultTarget);
revealResultTarget();
