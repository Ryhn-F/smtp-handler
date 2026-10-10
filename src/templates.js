'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

const NAMES = [
  'confirmation',
  'invite',
  'magic_link',
  'recovery',
  'email_change',
  'email_change_current',
  'reauthentication',
];

const SUBJECTS = {
  confirmation: 'Konfirmasi email akun DentisAI',
  invite: 'Undangan akun DentisAI',
  magic_link: 'Masuk ke akun DentisAI',
  recovery: 'Atur ulang kata sandi DentisAI',
  email_change: 'Konfirmasi perubahan email DentisAI',
  email_change_current: 'Persetujuan perubahan email DentisAI',
  reauthentication: 'Kode verifikasi DentisAI',
};

const HTML_WRAPPER_HEAD =
  '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>DentisAI</title></head>' +
  '<body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:480px;margin:0 auto;padding:16px;line-height:1.5">';
const HTML_WRAPPER_TAIL =
  '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0 8px">' +
  '<p style="color:#666;font-size:12px">Email ini dikirim otomatis oleh DentisAI. Mohon tidak membalas email ini.</p>' +
  '</body></html>';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Single-pass {{Name}} substitution. Values are escaped; unknown names become ''.
 * Because it is one regex pass, a value containing "{{Other}}" is never re-expanded.
 */
function substitute(template, vars, escape) {
  return template.replace(PLACEHOLDER, (_m, name) => {
    const v = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : '';
    return escape(v === undefined || v === null ? '' : v);
  });
}

function stripCrLf(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
}

function loadTemplates(dir = TEMPLATE_DIR) {
  const out = {};
  for (const name of NAMES) {
    const html = fs
      .readFileSync(path.join(dir, `${name}.html`), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '') // owner-review comments must not be sent
      .trim();
    const text = fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8').trim();
    out[name] = { html, text, subject: SUBJECTS[name] };
  }
  return out;
}

function render(templates, name, vars) {
  const t = templates[name];
  if (!t) throw new Error('unknown template');
  return {
    subject: t.subject,
    html: HTML_WRAPPER_HEAD + substitute(t.html, vars, escapeHtml) + HTML_WRAPPER_TAIL,
    text: substitute(t.text, vars, stripCrLf) + '\n',
  };
}

module.exports = { loadTemplates, render, substitute, escapeHtml, NAMES, SUBJECTS };
