import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { V8App } from './v8/V8App';
import brandLogo from './projects/office/assets/furball-v1.png';
import './design/global.css';

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
favicon.href = brandLogo;
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  const img = document.createElement('img');
  img.src = brandLogo;
  img.alt = 'Beastie Works';
  img.style.cssText = 'height:56px;width:auto;display:block';
  splashMark.replaceWith(img);
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

// 小怪工坊 is the v8 workbench only (老板 2026-11-20: our own project, not Munder Difflin's office). The old office UI
// is no longer loaded, so neither it nor its assets go into the package.
createRoot(root).render(
  <StrictMode>
    <V8App />
  </StrictMode>
);
