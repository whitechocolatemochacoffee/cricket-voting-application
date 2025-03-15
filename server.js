// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public')); // serve static files from public/

// File paths
const votersFile = path.join(__dirname, 'votersPool.json');
const resultsFile = path.join(__dirname, 'matchResults.json');

// Helper functions for votersPool.json
function readVotersData() {
  return JSON.parse(fs.readFileSync(votersFile));
}
function writeVotersData(data) {
  fs.writeFileSync(votersFile, JSON.stringify(data, null, 2));
}

// Helper functions for matchResults.json
function readResultsData() {
  if (fs.existsSync(resultsFile)) {
    return JSON.parse(fs.readFileSync(resultsFile));
  }
  return { results: [] };
}
function writeResultsData(data) {
  fs.writeFileSync(resultsFile, JSON.stringify(data, null, 2));
}

// Login endpoint
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const data = readVotersData();
  const user = data.votersPool.find(u => u.email === email && u.password === password);
  if (user) {
    const { password, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.json({ success: false });
  }
});

// Voting endpoint – update vote if it already exists
app.post('/vote', (req, res) => {
  const { email, voteDetails } = req.body;
  // voteDetails: { matchDate, matchName, votedTeam, motm: { teamA: [val1, val2], teamB: [val1, val2] } }
  const data = readVotersData();
  const userIndex = data.votersPool.findIndex(u => u.email === email);
  if (userIndex === -1) {
    return res.status(400).json({ success: false, message: 'User not found' });
  }
  const voteIndex = data.votersPool[userIndex].votingInfo.findIndex(info => info.matchName === voteDetails.matchName);
  if (voteIndex !== -1) {
    data.votersPool[userIndex].votingInfo[voteIndex] = voteDetails;
  } else {
    data.votersPool[userIndex].votingInfo.push(voteDetails);
  }
  writeVotersData(data);
  res.json({ success: true, message: 'Vote recorded successfully!' });
});

// Endpoint for declaring/updating winner
app.post('/declare-winner', (req, res) => {
  const { matchName, winner } = req.body;
  const resultsData = readResultsData();
  const index = resultsData.results.findIndex(r => r.matchName === matchName);
  if (index !== -1) {
    resultsData.results[index].winner = winner;
  } else {
    resultsData.results.push({ matchName, winner, declaredMotm: { teamA: [], teamB: [] } });
  }
  writeResultsData(resultsData);
  res.json({ success: true, message: "Winner declared successfully!" });
});

// Endpoint for declaring/updating MOTM
// Expects declaredMotm: { teamA: [val1, val2], teamB: [val1, val2] }
app.post('/declare-motm', (req, res) => {
  const { matchName, declaredMotm } = req.body;
  const resultsData = readResultsData();
  const index = resultsData.results.findIndex(r => r.matchName === matchName);
  if (index !== -1) {
    resultsData.results[index].declaredMotm = declaredMotm;
  } else {
    resultsData.results.push({ matchName, winner: "", declaredMotm });
  }
  writeResultsData(resultsData);
  res.json({ success: true, message: "Man of the Match declared successfully!" });
});

// Endpoint to finalize match and update financials
app.post('/finalize-match', (req, res) => {
  const { matchName } = req.body;
  const resultsData = readResultsData();
  const matchResult = resultsData.results.find(r => r.matchName === matchName);
  if (!matchResult || !matchResult.winner ||
      !matchResult.declaredMotm.teamA.length || !matchResult.declaredMotm.teamB.length) {
    return res.status(400).json({ success: false, message: 'Match result not fully declared yet' });
  }
  const votersData = readVotersData();
  const totalVoters = votersData.votersPool.length;
  // Assume perMatchContri and perMotmContri are same for all voters; take from first voter.
  const sample = votersData.votersPool[0];
  const perMatchContri = sample.perMatchContri;
  const perMotmContri = sample.perMotmContri;
  
  // Calculate match prediction counts
  let countWinning = 0, countLosing = 0;
  votersData.votersPool.forEach(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    if (vote) {
      if (vote.votedTeam === matchResult.winner) countWinning++;
      else countLosing++;
    }
  });
  const countNoVote = totalVoters - (countWinning + countLosing);
  const winningAmountTeam = countWinning > 0 ? ((countLosing + countNoVote) * perMatchContri) / countWinning : 0;
  
  // For MOTM calculations per team – we expect two selections per voter.
  function calcMotm(voterVotes, declaredArray) {
    let correct = 0, wrong = 0;
    // Expect two entries; if an entry is empty, count as wrong.
    for (let i = 0; i < 2; i++) {
      const sel = voterVotes && voterVotes[i] ? voterVotes[i] : "";
      if (sel && declaredArray.includes(sel)) {
        correct++;
      } else {
        wrong++;
      }
    }
    return { correct, wrong };
  }
  
  let correctCountA = 0, wrongCountA = 0;
  let correctCountB = 0, wrongCountB = 0;
  votersData.votersPool.forEach(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    if (!vote || !vote.motm) {
      wrongCountA += 2;
      wrongCountB += 2;
    } else {
      const resA = calcMotm(vote.motm.teamA, matchResult.declaredMotm.teamA);
      correctCountA += resA.correct;
      wrongCountA += resA.wrong;
      const resB = calcMotm(vote.motm.teamB, matchResult.declaredMotm.teamB);
      correctCountB += resB.correct;
      wrongCountB += resB.wrong;
    }
  });
  
  const winningAmountMotmA = correctCountA > 0 ? (wrongCountA * perMotmContri) / correctCountA : 0;
  const winningAmountMotmB = correctCountB > 0 ? (wrongCountB * perMotmContri) / correctCountB : 0;
  
  // Update each voter’s currentStanding
  votersData.votersPool = votersData.votersPool.map(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    if (!vote) {
      // Did not vote: lose perMatchContri and 2×perMotmContri
      voter.currentStanding -= perMatchContri;
      voter.currentStanding -= 2 * perMotmContri;
    } else {
      // For match prediction:
      if (vote.votedTeam === matchResult.winner) {
        voter.currentStanding += winningAmountTeam;
      } else {
        voter.currentStanding -= winningAmountTeam;
      }
      // For MOTM teamA:
      const motmA = calcMotm(vote.motm.teamA, matchResult.declaredMotm.teamA);
      // For each selection: if correct, add winning amount; if wrong, deduct perMotmContri.
      for (let i = 0; i < 2; i++) {
        const sel = vote.motm.teamA[i] ? vote.motm.teamA[i] : "";
        if (sel && matchResult.declaredMotm.teamA.includes(sel)) {
          voter.currentStanding += winningAmountMotmA;
        } else {
          voter.currentStanding -= perMotmContri;
        }
      }
      // For MOTM teamB:
      const motmB = calcMotm(vote.motm.teamB, matchResult.declaredMotm.teamB);
      for (let i = 0; i < 2; i++) {
        const sel = vote.motm.teamB[i] ? vote.motm.teamB[i] : "";
        if (sel && matchResult.declaredMotm.teamB.includes(sel)) {
          voter.currentStanding += winningAmountMotmB;
        } else {
          voter.currentStanding -= perMotmContri;
        }
      }
    }
    return voter;
  });
  writeVotersData(votersData);
  res.json({ success: true, message: 'Financials updated successfully', voters: votersData.votersPool });
});

// Endpoint to get voters data (without passwords) for scoreboard
app.get('/voters', (req, res) => {
  const data = readVotersData();
  data.votersPool = data.votersPool.map(v => {
    const { password, ...rest } = v;
    return rest;
  });
  res.json(data);
});

// Endpoint to get current match results
app.get('/results', (req, res) => {
  res.json(readResultsData());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
