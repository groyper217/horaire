// Importing a team list pasted from WFM / Excel, or read from a CSV file.
const test = require('node:test');
const assert = require('node:assert');
const H = require('../logic.js');

const names = r => r.people.map(p => p.name);

test('one name per line', () => {
  const r = H.parseTeamList('Alexandre Tremblay\n\nCamille Gagnon\n  Marc Roy  \n');
  assert.deepStrictEqual(names(r), ['Alexandre Tremblay', 'Camille Gagnon', 'Marc Roy']);
  assert.strictEqual(r.notes.stationGuessed, 3);
  assert.deepStrictEqual(r.people[0].stations, ['kitchen', 'front']);
  assert.deepStrictEqual(r.people[0].availability[0], [{ start: 0, end: 1440 }]);
});

test('"Last, First" without a header becomes "First Last"', () => {
  assert.deepStrictEqual(names(H.parseTeamList('Tremblay, Alexandre\nGagnon, Camille')), ['Alexandre Tremblay', 'Camille Gagnon']);
});

test('pasted from Excel (tabs) with a French header', () => {
  const text = [
    'Prénom\tNom\tPoste\tHeures max\tLun\tMar\tMer\tJeu\tVen\tSam\tDim',
    'Léa\tCôté\tCuisine\t32\t6-14\t6-14\tnon\t\t16h-23h\toui\toui',
    'Karim\tSimard\tCaisse\t20\t\t\t\t\t\t22:00-06:00\tx',
  ].join('\n');
  const r = H.parseTeamList(text);
  assert.deepStrictEqual(names(r), ['Léa Côté', 'Karim Simard']);
  const [lea, karim] = r.people;
  assert.deepStrictEqual(lea.stations, ['kitchen']);
  assert.strictEqual(lea.maxHours, 32);
  assert.deepStrictEqual(lea.availability[0], [{ start: 360, end: 840 }]);
  assert.deepStrictEqual(lea.availability[2], []);                       // "non"
  assert.deepStrictEqual(lea.availability[3], []);                       // empty cell, other days filled
  assert.deepStrictEqual(lea.availability[4], [{ start: 960, end: 1380 }]);
  assert.deepStrictEqual(lea.availability[5], [{ start: 0, end: 1440 }]); // "oui"
  assert.deepStrictEqual(karim.stations, ['front']);
  assert.deepStrictEqual(karim.availability[5], [{ start: 1320, end: 1800 }]); // crosses midnight
  assert.strictEqual(r.notes.stationGuessed, 0);
});

test('CSV with quotes and semicolons, English header', () => {
  const r = H.parseTeamList('"Name";"Position";"Max hours"\n"Roy, Marc";"Both";"25,5"\n');
  assert.deepStrictEqual(names(r), ['Marc Roy']);
  assert.deepStrictEqual(r.people[0].stations, ['kitchen', 'front']);
  assert.strictEqual(r.people[0].maxHours, 25.5);
});

test('a first row like "Marc" is a person, not the "Mardi" column', () => {
  assert.deepStrictEqual(names(H.parseTeamList('Marc\nSam')), ['Marc', 'Sam']);
});

test('people already in the app are skipped, accents ignored', () => {
  const existing = [{ name: 'Lea Cote' }];
  const r = H.parseTeamList('Léa Côté\nNoémie Roy\nnoemie roy', existing);
  assert.deepStrictEqual(names(r), ['Noémie Roy']);
  assert.deepStrictEqual(r.notes.duplicates, ['Léa Côté', 'noemie roy']);
});
