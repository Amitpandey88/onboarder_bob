export function initBlameView(container) {
  return function renderBlame(blameData, options = {}) {
    if (!blameData || !blameData.lines) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.innerHTML = '';
    
    // Hash author to color
    function getAuthorColor(author) {
      let hash = 0;
      for (let i = 0; i < author.length; i++) hash = author.charCodeAt(i) + ((hash << 5) - hash);
      return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
    }

    blameData.lines.forEach(line => {
      const div = document.createElement('div');
      div.className = 'blame-line';
      div.style.backgroundColor = getAuthorColor(line.author || 'Unknown');
      
      const tooltip = document.createElement('div');
      tooltip.className = 'blame-tooltip';
      tooltip.textContent = `${line.author} - ${line.date || ''} (${(line.sha || '').substring(0, 7)})`;
      
      div.appendChild(tooltip);
      container.appendChild(div);
    });
  };
}

export async function fetchBlame(scanId, path) {
  try {
    const res = await fetch(`/api/blame?scan=${encodeURIComponent(scanId)}&path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('Failed to fetch blame:', err);
    return null;
  }
}
