// This module never calls the asynchronous Headless mutators.
export function planTeams(players, teamSize, ratingById = {}) {
  if (!Number.isInteger(teamSize) || teamSize < 1) throw new RangeError('teamSize');
  const ordered = [...players].sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0) || a.id - b.id);
  const selected = ordered.slice(0, teamSize * 2);
  const queue = ordered.slice(teamSize * 2);
  const strength = player => Number.isFinite(ratingById[player.identityId]) ? ratingById[player.identityId] : 1000;
  const sorted = [...selected].sort((a, b) => strength(b) - strength(a) || a.id - b.id);
  const teams = { red: [], blue: [] };
  let redScore = 0;
  let blueScore = 0;
  for (const player of sorted) {
    const redAvailable = teams.red.length < Math.ceil(selected.length / 2);
    const blueAvailable = teams.blue.length < Math.floor(selected.length / 2);
    const toRed = redAvailable && (!blueAvailable || redScore <= blueScore);
    teams[toRed ? 'red' : 'blue'].push(player);
    if (toRed) redScore += strength(player);
    else blueScore += strength(player);
  }
  // Local pair exchanges improve strength difference without changing team sizes.
  let improved = true;
  while (improved) {
    improved = false;
    for (const red of teams.red) {
      for (const blue of teams.blue) {
        const newRed = redScore - strength(red) + strength(blue);
        const newBlue = blueScore - strength(blue) + strength(red);
        if (Math.abs(newRed - newBlue) + 0.001 < Math.abs(redScore - blueScore)) {
          teams.red[teams.red.indexOf(red)] = blue;
          teams.blue[teams.blue.indexOf(blue)] = red;
          redScore = newRed;
          blueScore = newBlue;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return { red: teams.red, blue: teams.blue, queue, cost: Math.abs(redScore - blueScore), version: 1 };
}
