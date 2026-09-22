#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker compose -p router-metering exec -T metering bun -e '
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
const dir="/data/backups";mkdirSync(dir,{recursive:true,mode:0o700});
const name=`usage-${new Date().toISOString().replaceAll(":","-")}.sqlite`;
const db=new Database("/data/usage.sqlite");
db.exec(`VACUUM INTO '\''${dir}/${name}'\''`);db.close();
for(const file of readdirSync(dir))if(/^usage-[0-9TZ:.-]+\.sqlite$/.test(file)&&Date.now()-statSync(`${dir}/${file}`).mtimeMs>14*86400000)unlinkSync(`${dir}/${file}`);
'
