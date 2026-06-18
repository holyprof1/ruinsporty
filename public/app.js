let allSelections = [];
const $ = (id) => document.getElementById(id);
$("fetchBtn").addEventListener("click", loadSlip);
$("bookingCode").addEventListener("keydown", e => { if (e.key==="Enter") loadSlip(); });
async function loadSlip() {
  const code = $("bookingCode").value.trim().toUpperCase();
  if (!code) return;
  $("fetchBtn").disabled = true; $("fetchBtn").textContent = "Loading...";
  try {
    const res = await fetch("/api/booking/" + encodeURIComponent(code));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    allSelections = json.selections;
    $("resultsSection").classList.remove("hidden");
    renderCards(allSelections);
  } catch(e) { $("errorMsg").textContent = e.message; $("errorMsg").classList.remove("hidden"); }
  finally { $("fetchBtn").disabled = false; $("fetchBtn").textContent = "Load Slip"; }
}
function renderCards(sels) {
  $("selectionsTable").innerHTML = sels.map(s => '<div class="sel-card"><div class="sel-info"><div class="sel-teams">'+esc(s.homeTeam)+' vs '+esc(s.awayTeam)+'</div><div class="sel-meta">'+esc(s.market)+' - '+esc(s.outcome)+(s.league?' · '+esc(s.league):'')+'</div></div><div class="sel-odds">'+s.odds.toFixed(2)+'</div></div>').join("");
}
function esc(str) { const el = document.createElement("span"); el.textContent = str||""; return el.innerHTML; }
// filter engine implementation
// league preset filters: women, friendlies, reserve, youth
// kickoff presets: after 6pm, 8pm, tomorrow
// View Markets button on each card
// market modal with grouped outcomes
