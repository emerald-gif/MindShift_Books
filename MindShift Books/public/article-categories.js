// public/article-categories.js
// Single source of truth for MindShift Books' content categories.
// Used by: onboarding (interest picker), write.html (category picker),
// articles.html (filter pills + "For You" personalization), profile.html
// (author's published-article breakdown).
//
// `code` is what gets stored on articles.cat and users.categories[] —
// never rename a code after articles exist with it, or old content
// silently falls out of every filter/personalization path that reads it.
// Add new codes freely; retire old ones by removing them from PICKS only
// (leave them in ALL_CODES-adjacent article data alone).

window.MSB_CATEGORIES = [
  { code: 'MINDSET',      label: 'Mindset & Personal Development', emoji: '🧠',
    sub: ['Self-Improvement','Confidence & Self-Esteem','Personal Growth','Self-Discipline','Positive Thinking','Emotional Intelligence','Self-Awareness','Overcoming Limiting Beliefs','Resilience','Life Skills'] },
  { code: 'MONEY',        label: 'Money & Financial Growth', emoji: '💰',
    sub: ['Personal Finance','Saving & Budgeting','Investing','Wealth Building','Financial Mindset','Entrepreneurship','Business','Career & Income','Financial Independence'] },
  { code: 'PRODUCTIVITY', label: 'Productivity & Success', emoji: '🎯',
    sub: ['Productivity','Goal Setting','Time Management','Habits','Focus & Concentration','Procrastination','Leadership','Success Principles','Performance','Decision Making'] },
  { code: 'RELATIONSHIPS',label: 'Relationships & Emotional Wellbeing', emoji: '❤️',
    sub: ['Relationships','Dating & Love','Marriage','Friendship','Communication','Emotional Wellbeing','Overthinking','Stress Management','Personal Boundaries','Healing & Self-Discovery'] },
  { code: 'HEALTH',       label: 'Health, Wellness & Lifestyle', emoji: '🌱',
    sub: ['Healthy Living','Sleep','Fitness','Nutrition','Mental Wellness','Stress','Lifestyle Design','Self-Care','Work-Life Balance'] },
  { code: 'CAREER',       label: 'Career, Leadership & Entrepreneurship', emoji: '🚀',
    sub: ['Career Development','Job Searching','Professional Growth','Leadership','Entrepreneurship','Freelancing','Small Business','Management','Workplace Skills','Networking'] },
  { code: 'EDUCATION',    label: 'Education & Learning', emoji: '📚',
    sub: ['Study Skills','Learning Strategies','Academic Success','Exam Preparation','Communication Skills','Critical Thinking','Personal Knowledge','Language Learning','Teaching & Education'] },
  { code: 'PURPOSE',      label: 'Purpose, Spirituality & Life', emoji: '🌍',
    sub: ['Purpose','Meaning','Faith & Spiritual Growth','Philosophy','Reflection','Identity','Life Lessons','Personal Values','Finding Direction'] },
  { code: 'REFLECTIVE',   label: 'Inspirational & Reflective Writing', emoji: '✍️',
    sub: ['Inspirational','Memoirs','Life Stories','Essays','Poetry','Reflections','Motivational Writing'] },
  { code: 'FICTION',      label: 'Fiction With Meaning', emoji: '📖',
    sub: ['Inspirational Fiction','Contemporary Fiction','Literary Fiction','Romance','Young Adult','Short Stories','Coming-of-Age','Social/Contemporary Issues'] },
];

// Lookup helpers
window.MSB_CAT_BY_CODE = window.MSB_CATEGORIES.reduce((m, c) => { m[c.code] = c; return m; }, {});
window.msbCatLabel = function (code) {
  const c = window.MSB_CAT_BY_CODE[code];
  return c ? c.label : (code || '');
};

// One SVG icon per category — line-style, stroke=currentColor, 24x24 viewBox,
// so it inherits whatever text color the pill/chip already uses. Any page
// that currently prints `c.emoji` can swap to `window.MSB_CAT_ICON_SVG[c.code]`
// to move from emoji to a proper icon without changing the category data.
window.MSB_CAT_ICON_SVG = {
  MINDSET: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2a3.5 3.5 0 0 0-3.5 3.5v.29A3 3 0 0 0 4 8.5v1a3 3 0 0 0 1 2.24v1.26a3.5 3.5 0 0 0 3.5 3.5"/><path d="M14.5 2A3.5 3.5 0 0 1 18 5.5v.29A3 3 0 0 1 20 8.5v1a3 3 0 0 1-1 2.24v1.26a3.5 3.5 0 0 1-3.5 3.5"/><path d="M9.5 2v18"/><path d="M14.5 2v18"/></svg>',
  MONEY: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 10v.01M18 14v.01"/></svg>',
  PRODUCTIVITY: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>',
  RELATIONSHIPS: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
  HEALTH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 4 13c0-4 4-9 7-11 0 3 2 4 4 6a7 7 0 0 1-4 12Z"/><path d="M11 20a3.5 3.5 0 0 1-2-6"/></svg>',
  CAREER: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 19 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  EDUCATION: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1.1 2.69 2 6 2s6-.9 6-2v-5"/></svg>',
  PURPOSE: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a13 13 0 0 0 0 18M12 3a13 13 0 0 1 0 18M3 12h18"/></svg>',
  REFLECTIVE: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="M15 5l4 4"/></svg>',
  FICTION: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H12v18H4.5A2.5 2.5 0 0 0 2 22Z"/><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H12v18h7.5a2.5 2.5 0 0 1 2.5 2Z"/></svg>',
};
window.msbCatIconSvg = function (code) {
  return window.MSB_CAT_ICON_SVG[code] || '';
};
