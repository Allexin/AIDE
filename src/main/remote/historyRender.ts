/**
 * Rendering of CLI transcript entries (HistoryEntry) shared by the remote pages
 * that show them: the terminal page's history drawer and the pipeline page's
 * step transcripts. Plain browser script, inserted into the pages' <script>;
 * it needs marked.js and purify.js loaded. No backticks or backslashes inside:
 * this text is a template literal.
 */

export const HISTORY_STYLE = `    .history-entry { padding: 10px 14px; border-bottom: 1px solid #2d2d2d; }
    .history-role { margin-bottom: 5px; color: #4ec9b0; font: bold 11px/1.3 monospace; text-transform: uppercase; letter-spacing: .04em; }
    .history-entry.user .history-role { color: #569cd6; }
    .history-md { overflow-wrap: anywhere; }
    .history-md > :first-child { margin-top: 0; }
    .history-md > :last-child { margin-bottom: 0; }
    .history-md p, .history-md ul, .history-md ol, .history-md blockquote, .history-md pre { margin: 7px 0; }
    .history-md ul, .history-md ol { padding-left: 22px; }
    .history-md blockquote { padding-left: 10px; color: #9a9a9a; border-left: 3px solid #555; }
    .history-md code { padding: 1px 4px; background: #2a2a2a; border-radius: 3px; font: 12px/1.4 Consolas, monospace; }
    .history-md pre { padding: 9px; overflow-x: auto; background: #181818; border: 1px solid #333; border-radius: 4px; }
    .history-md pre code { padding: 0; background: transparent; }
    .history-md a { color: #4fc3f7; }`

export const HISTORY_RENDER_SCRIPT = `    function historyBlockMarkdown(block) {
      if (!block) return ''
      if (block.type === 'text') return block.text || ''
      var NL = String.fromCharCode(10)
      if (block.type === 'thinking') {
        return '> **Thinking**' + NL + '>' + NL + String(block.thinking || '').split(NL).map(function(line) { return '> ' + line }).join(NL)
      }
      var fence = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96)
      if (block.type === 'tool_use') {
        var input = ''
        try { input = JSON.stringify(block.input, null, 2) } catch (err) { input = String(block.input || '') }
        return '**' + String(block.name || 'tool') + '**' + NL + NL + fence + 'json' + NL + input + NL + fence
      }
      if (block.type === 'tool_result') {
        var content = block.content
        if (Array.isArray(content)) content = content.filter(function(item) { return item && item.type === 'text' }).map(function(item) { return item.text || '' }).join(NL)
        return '**Result**' + NL + NL + fence + NL + String(content || '') + NL + fence
      }
      return ''
    }
    function renderHistoryMarkdown(entry) {
      var NL = String.fromCharCode(10)
      var source = (entry.blocks || []).map(historyBlockMarkdown).filter(Boolean).join(NL + NL)
      try {
        var html = window.marked.parse(source, { gfm: true, breaks: true })
        return window.DOMPurify.sanitize(html)
      } catch (err) {
        return '<p>' + String(source).replace(/[&<>]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] }).split(NL).join('<br>') + '</p>'
      }
    }`
