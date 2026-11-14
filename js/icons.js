const s = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const f = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">${d}</svg>`;

export const icon = {
  play: f('<path d="M8 5.2c0-.8.9-1.3 1.6-.9l10 6.3c.6.4.6 1.4 0 1.8l-10 6.3c-.7.4-1.6-.1-1.6-.9z"/>'),
  pause: f('<rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/>'),
  next: f('<path d="M5.5 6.6c0-.8.9-1.3 1.5-.8l7.6 5.4c.5.4.5 1.2 0 1.6L7 18.2c-.6.5-1.5 0-1.5-.8z"/><rect x="16.2" y="5.5" width="2.6" height="13" rx="1.1"/>'),
  prev: f('<path d="M18.5 6.6c0-.8-.9-1.3-1.5-.8l-7.6 5.4c-.5.4-.5 1.2 0 1.6l7.6 5.4c.6.5 1.5 0 1.5-.8z"/><rect x="5.2" y="5.5" width="2.6" height="13" rx="1.1"/>'),
  shuffle: s('<path d="M3.5 7h2.8c1.9 0 3.1.9 4.2 2.6l3 4.8c1.1 1.7 2.3 2.6 4.2 2.6h2.8"/><path d="M17.5 4.5 20.5 7l-3 2.5"/><path d="M17.5 14.5l3 2.5-3 2.5"/><path d="M3.5 17h2.8c1.3 0 2.3-.4 3.1-1.3"/><path d="M13.6 8.3c.8-.9 1.8-1.3 3.1-1.3h3.8"/>'),
  repeat: s('<path d="M4.5 11.5v-1.2A3.3 3.3 0 0 1 7.8 7h11.2"/><path d="M16.5 4.2 19.3 7l-2.8 2.8"/><path d="M19.5 12.5v1.2a3.3 3.3 0 0 1-3.3 3.3H5"/><path d="M7.5 19.8 4.7 17l2.8-2.8"/>'),
  heart: s('<path d="M12 19.6s-7.1-4.3-7.1-9.7A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7.1 2.3c0 5.4-7.1 9.7-7.1 9.7z"/>'),
  more: f('<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>'),
  plus: s('<path d="M12 5.5v13M5.5 12h13"/>', 'stroke-width="2"'),
  tune: s('<path d="M4 7.5h9M18 7.5h2M4 16.5h3M11 16.5h9"/><circle cx="15.5" cy="7.5" r="2.2"/><circle cx="8.8" cy="16.5" r="2.2"/>'),
  down: s('<path d="M6.5 9.5 12 15l5.5-5.5"/>'),
  search: s('<circle cx="10.8" cy="10.8" r="6.2"/><path d="m15.5 15.5 4 4"/>'),
  bt: s('<path d="m7 7.5 10 9-5 4.2V3.3l5 4.2-10 9"/>'),
  close: s('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
};

export const keysArt = `<svg viewBox="0 0 168 84" width="168" height="84" aria-hidden="true" class="keys-art">
  <rect x="0" y="0" width="168" height="5" rx="2" fill="var(--felt)"/>
  ${[0, 1, 2, 3, 4, 5, 6].map(i => `<rect x="${i * 24 + 1}" y="7" width="22" height="76" rx="4" fill="var(--ivory-key)" stroke="var(--line-strong)"/>`).join('')}
  <rect x="49" y="7" width="22" height="76" rx="4" fill="var(--accent)"/>
  ${[0, 1, 3, 4, 5].map(i => `<rect x="${i * 24 + 16}" y="7" width="14" height="46" rx="3" fill="var(--ebony)"/>`).join('')}
</svg>`;
