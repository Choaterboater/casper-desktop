const { add } = require('./calc.cjs')
const got = add(2, 3)
if (got !== 5) {
  console.error(`add(2, 3) returned ${got}, expected 5`)
  process.exit(1)
}
console.log('ok: add(2, 3) is 5')
