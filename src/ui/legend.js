// Overlay definitions. Colours must match overlay() in src/render/shaders.js.
export const OVERLAYS = [
  {
    id: 0, name: 'Natural view', dot: 'linear-gradient(135deg,#8b7d6b,#e8ecef)',
    desc: 'The land as you would see it: rock, talus, soil, plants, snow and water.',
  },
  {
    id: 1, name: 'Water depth', dot: '#3a8ff0',
    desc: 'Where water is flowing or pooling, from a thin film to deep lakes.',
    gradient: 'linear-gradient(90deg, rgb(179,237,255), rgb(38,140,242), rgb(10,26,115))',
    labels: ['1 mm', '10 cm', '10 m'],
    note: 'Blue lines are streams; dark blue patches are lakes and ponds.',
  },
  {
    id: 2, name: 'Sediment in water', dot: '#e98a1f',
    desc: 'Mud and gravel being carried by the water right now.',
    gradient: 'linear-gradient(90deg, rgb(255,235,115), rgb(242,140,31), rgb(115,46,13))',
    labels: ['a trace', '1 cm', '1 m'],
    note: 'Bright orange marks the busiest streams, where the land is being moved. At fast speeds the amount is scaled up with time.',
  },
  {
    id: 3, name: 'Snowpack', dot: '#9fc9f5',
    desc: 'How much water is stored as snow (snow water equivalent).',
    gradient: 'linear-gradient(90deg, rgb(217,247,255), rgb(77,166,242), rgb(102,46,179))',
    labels: ['1 mm', '0.5 m', '2 m of water'],
    note: 'Fresh snow is about 3x deeper than its water content. Snow slides off very steep slopes and piles up below.',
  },
  {
    id: 4, name: 'Frozen ground', dot: '#8f6fe0',
    desc: 'How deep the soil and rock are frozen. Frozen ground lets less water soak in.',
    gradient: 'linear-gradient(90deg, rgb(217,204,255), rgb(140,102,230), rgb(56,20,115))',
    labels: ['1 cm', '1 m', '2 m'],
    note: 'A snowpack insulates the ground, so frost goes deepest on wind-blown bare ridges.',
  },
  {
    id: 5, name: 'Erosion & deposition', dot: 'linear-gradient(90deg,#b3141a,#fff,#1440bf)',
    desc: 'How much the ground has been lowered (red) or built up (blue) since the start.',
    gradient: 'linear-gradient(90deg, rgb(179,20,26), rgb(255,217,191) 45%, rgba(255,255,255,0.4) 50%, rgb(204,224,255) 55%, rgb(20,64,191))',
    labels: ['-50 m', '-1 m', '0', '+1 m', '+50 m'],
    note: 'Red: worn away by streams, landslides and frost. Blue: sediment dropped in valleys, fans and lakes.',
  },
  {
    id: 6, name: 'Groundwater & springs', dot: '#2fb3a0',
    desc: 'How full the ground is with water, and where it comes back out as springs.',
    gradient: 'linear-gradient(90deg, rgb(237,204,140), rgb(153,191,224), rgb(26,56,158)), linear-gradient(90deg, transparent, transparent)',
    labels: ['drier (20% full)', 'half full', 'wet (80%+)'],
    note: 'Rain soaks in, creeps downhill underground, and fills the ground in hollows and valley bottoms. Bright teal spots are springs where it comes back out and feeds the streams.',
  },
  {
    id: 7, name: 'Plants', dot: 'linear-gradient(135deg,#a8d65c,#1f7a2a)',
    desc: 'How much of the ground plants cover, from bare rock to closed forest, and where fires have burned.',
    gradient: 'linear-gradient(90deg, rgb(237,219,179), rgb(168,214,92), rgb(31,122,41), rgb(10,77,61))',
    labels: ['bare', 'sparse', 'grass & shrubs', 'forest'],
    note: 'Plants grow where there is water, warmth and soil: watch for green stream banks, the treeline on the peaks, and greener north faces in dry country. Orange to dark red: burned in the last few years.',
  },
];

export function showLegend(id) {
  const o = OVERLAYS.find((x) => x.id === id);
  const el = document.getElementById('legend');
  if (!o || !o.gradient) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  document.getElementById('legend-title').textContent = o.name;
  document.getElementById('legend-bar').style.background = o.gradient;
  document.getElementById('legend-labels').innerHTML = o.labels.map((l) => `<span>${l}</span>`).join('');
  document.getElementById('legend-note').textContent = o.note;
}
