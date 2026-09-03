// history.js
// Builds and formats the event history: every automatic detection and every
// manual count correction is recorded here so users can audit or undo them.

import { createId } from './state.js';

export function createHistoryEntry({
  targetId,
  targetName,
  action, // 'increment' | 'decrement' | 'reset' | 'undo'
  source, // 'auto' | 'manual'
  previousValue,
  newValue,
  score = null,
  reason = '',
}) {
  return {
    id: createId('event'),
    timestamp: Date.now(),
    targetId,
    targetName,
    action,
    source,
    previousValue,
    newValue,
    score,
    reason,
  };
}

export function actionLabel(action) {
  switch (action) {
    case 'increment': return '+1';
    case 'decrement': return '-1';
    case 'reset': return 'リセット';
    case 'undo': return '取り消し';
    default: return action;
  }
}

export function sourceLabel(source) {
  return source === 'auto' ? '自動検出' : '手動操作';
}

export function historyToJson(history) {
  return JSON.stringify(history, null, 2);
}

/** UTF-8 BOM prefix keeps common spreadsheet apps from mis-decoding Japanese text. */
export function historyToCsv(history) {
  const headers = ['時刻', '対象名', '操作', '種別', '変更前', '変更後', 'スコア', '理由'];
  const rows = history.map((h) => [
    new Date(h.timestamp).toLocaleString('ja-JP'),
    h.targetName,
    actionLabel(h.action),
    sourceLabel(h.source),
    h.previousValue,
    h.newValue,
    h.score != null ? h.score.toFixed(3) : '',
    h.reason || '',
  ]);
  const body = [headers, ...rows].map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  return `﻿${body}`;
}

function escapeCsvField(field) {
  const str = String(field ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
