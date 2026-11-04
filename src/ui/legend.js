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
    id: 7, name: 'Plants & burn scars', dot: 'linear-gradient(135deg,#eedc9e,#9ed65a,#1a7a29)',
    desc: 'Where plants grow, from bare ground to grass, shrubs and forest, and where fire has burned.',
    gradient: 'linear-gradient(90deg, rgb(237,219,158), rgb(158,214,82), rgb(26,122,41) 80%, rgb(5,66,26))',
    labels: ['bare', 'grass', 'forest'],
    note: 'Plants need warmth (there is a treeline), water and some soil. Red patches burned recently; they turn green again as grass, then shrubs, then trees come back. Orange is fire burning now.',
  },
  {
    id: 8, name: 'Sediment beds', dot: 'linear-gradient(90deg,#8cb3cc,#e6c780,#fae040,#8c4d26)',
    desc: 'The beds of mud, sand and gravel the water has laid down, by the grain of the top bed.',
    gradient: 'linear-gradient(90deg, rgb(140,179,204), rgb(230,199,128) 33%, rgb(250,224,64) 66%, rgb(140,77,38))',
    labels: ['clay', 'silt', 'sand', 'gravel'],
    note: 'Fast channels drop gravel, spreading floodwater drops silt and sand, still ponds drop clay. Stronger colour means a thicker fill. The beds stack up over time and show as bands on the block sides and wherever a stream cuts back down.',
  },
  {
    id: 9, name: 'Wind & sand', dot: 'linear-gradient(135deg,#d9ebfa,#59a6f2,#fad14d)',
    desc: 'How hard the wind blows over each spot, where the land shelters it, and where wind-blown sand lies.',
    gradient: 'linear-gradient(90deg, rgb(217,235,250), rgb(89,166,242), rgb(140,38,179))',
    labels: ['calm', 'the prevailing wind', '2x'],
    note: 'Wind speeds up over crests and windward slopes and drops in the lee (dark) behind ridges and dunes, where sand and snow pile up. Gold marks loose wind-blown sand: dunes and sand sheets.',
  },
  {
    id: 10, name: 'Glaciers', dot: 'linear-gradient(135deg,#cdf5ff,#338cf2,#8c26b3)',
    desc: 'Where glacier ice lies and how fast it flows.',
    gradient: 'linear-gradient(90deg, rgb(204,245,255), rgb(51,140,242), rgb(140,38,179))',
    labels: ['1 m/yr', '15 m/yr', '200 m/yr'],
    note: 'Ice moves fastest in the middle of a glacier and slows to a stop at its snout, where it melts. Thin ice at the edges is pale. Brown marks rock the ice is carrying, which it drops as moraines. Glaciers need snow that lasts all summer: turn the temperature down to grow them.',
  },
  {
    id: 11, name: 'Volcanic rock', dot: 'linear-gradient(135deg,#333d73,#e64d26,#8c33b3)',
    desc: 'Rock made by volcanoes, under the soil or at the surface, and lava that is still molten.',
    gradient: 'linear-gradient(90deg, rgb(51,61,115) 0 12.5%, rgb(230,77,38) 12.5% 25%, rgb(140,51,179) 25% 37.5%, rgb(115,158,204) 37.5% 50%, rgb(235,224,179) 50% 62.5%, rgb(217,153,64) 62.5% 75%, rgb(102,179,102) 75% 87.5%, rgb(255,166,26) 87.5%)',
    labels: ['basalt', 'cinders', 'plug', 'andesite', 'ash', 'tuff', 'breccia', 'lava'],
    note: 'Basalt is set lava: very hard, so old flows end up capping ridges and mesas. Cinders are loose and frothy and wash away quickly. The plug is lava that set in the throat of the volcano; it outlasts the cone as a rocky neck. Andesite and dacite are the stiff lavas of Vulcanian and Pelean eruptions (lava domes). Ash and pumice from explosive eruptions is the softest of all, so rain soon gullies it. Tuff is ash welded or packed together: tuff rings round maars, and the ignimbrite left by pyroclastic flows. Breccia is the broken old rock thrown out by steam blasts. Paint a volcano with the Volcano brush (pick the eruption style under it), or load maps until one starts with an old volcano.',
  },
  {
    id: 12, name: 'Subsurface', dot: 'linear-gradient(135deg,#0dbfcc,#264df2,#ff4019)',
    desc: 'What the rock under each spot does underground: dissolves, carries groundwater, or warms the ground.',
    gradient: 'linear-gradient(90deg, rgb(13,191,204) 0 20%, rgb(255,255,255) 20% 40%, rgb(38,77,242) 40% 60%, rgb(13,13,15) 60% 80%, rgb(255,64,26) 80%)',
    labels: ['soluble rock', 'salt', 'water conduits', 'hard intrusions', 'hot ground'],
    note: 'Cyan: limestone, gypsum and chalk that groundwater slowly dissolves (karst). White: salt, which dissolves fast so the ground above it sinks. Blue: fault zones, joints, breccia pipes and hot-spring conduits that carry groundwater fast (cave conduits in limestone show as cyan) and feed springs. Black: dikes, laccolith cores and volcanic necks that resist erosion. Red: ground warmed by a hot spring. Pick a province in Geology to see its own set; the landscape description lists each one with its geophysical signature.',
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
