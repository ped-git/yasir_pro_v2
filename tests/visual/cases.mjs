// Representative pages and states. Each case is driven identically against both projects.
// Selection rationale is in tests/README.md: layout breadth (short/long, sections,
// gradient underlines, editor-authored page CSS, deeper relative paths, index, explanation).
export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

export const readerCases = [
  { id: '001_fatiha', page: 'Surah/001_Fatiha_html.html', label: 'Al-Fatiha — short, underlines only', states: ['idle', 'hover-underline', 'underlines-hidden', 'print', 'mobile'] },
  { id: '002_baqarah', page: 'Surah/002_Baqarah_html.html', label: 'Al-Baqarah — longest, 35 vertical sections', states: ['idle', 'hover-underline', 'hover-line', 'collapsed', 'expanded', 'nested-collapse', 'simple-layout', 'underlines-hidden', 'keyboard-focus', 'print', 'mobile'], tall: true },
  { id: '003_aleimran', page: 'Surah/003_AleImran_html.html', label: 'Ale Imran — editor-authored page CSS + beta annotations', states: ['idle', 'hover-underline', 'hover-line', 'collapsed', 'print', 'mobile'], tall: true },
  { id: '059_hashr', page: 'Surah/059_Hashr_html.html', label: 'Al-Hashr — editor-authored page CSS, quotation pairs', states: ['idle', 'hover-underline', 'collapsed', 'print'] },
  { id: '055_rahman', page: 'Surah/055_AlRahman_html.html', label: 'Ar-Rahman — repeated refrain groups', states: ['idle', 'hover-underline', 'print'] },
  { id: '067_molk', page: 'Surah/067_Molk_html.html', label: 'Al-Mulk — gradient underlines', states: ['idle', 'hover-underline', 'hover-line', 'collapsed', 'print'] },
  { id: '112_ekhlas', page: 'Surah/112_Ekhlas_html.html', label: 'Al-Ikhlas — shortest page with a section', states: ['idle', 'hover-underline', 'collapsed', 'print', 'mobile'] },
  { id: '061_saff_farsi', page: 'Surah/Farsi/061_Saff_farsi.html', label: 'Saff Farsi — deeper relative asset paths', states: ['idle', 'print'] },
  { id: 'index', page: 'index.html', label: 'Reader index — surah navigation list', states: ['idle', 'print', 'mobile'] },
  { id: 'explanation', page: 'explanation.html', label: 'Reader explanation page', states: ['idle', 'print'] },
];

export const editorCases = [
  { id: 'editor_baqarah', page: 'Surah/002_Baqarah_html.html', label: 'Editor canvas — Al-Baqarah', states: ['ready', 'hover-underline', 'group-selected'] },
  { id: 'editor_fatiha', page: 'Surah/001_Fatiha_html.html', label: 'Editor canvas — Al-Fatiha', states: ['ready'] },
  { id: 'editor_catalog', page: 'Surah/003_AleImran_html.html', label: 'Editor style catalogue sidebar', states: ['catalog'] },
];
