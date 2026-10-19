const fs = require("node:fs");
const path = require("node:path");

module.exports = ({ id, dir, electron }) => {
  const marker = { id, dir, hasApp: typeof electron.app?.getVersion === "function", pid: process.pid };
  fs.writeFileSync(path.join(process.env.T3CODE_HOME, "sample-main-ran.json"), JSON.stringify(marker));
};
