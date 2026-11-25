import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const storePackage = /^OpenAI\.Codex_\d+\.\d+\.\d+\.\d+_x64__2p2nqsd0c76g0$/i;
const storeServerPath = path.join('app', 'resources', 'codex.exe');
const isFile = file => stat(file).then(value => value.isFile(), () => false);

async function storePackages(root) {
  return (await readdir(root, {withFileTypes:true}).catch(() => []))
    .filter(row => row.isDirectory() && storePackage.test(row.name))
    .sort((a,b) => b.name.localeCompare(a.name,'en',{numeric:true}));
}

export async function resolveSharedDesktop(configured, {programFiles = process.env.ProgramW6432 || process.env.ProgramFiles} = {}) {
  const roots = new Set();
  let registered;
  if (configured) {
    const configuredPath = path.resolve(configured);
    const packageDir = path.dirname(path.dirname(path.dirname(configuredPath)));
    const root = path.dirname(packageDir);
    if (path.basename(root).toLowerCase() === 'windowsapps' && storePackage.test(path.basename(packageDir)) &&
        path.relative(packageDir, configuredPath).toLowerCase() === storeServerPath) {
      roots.add(root);
      registered = {desktop: path.join(packageDir, 'app', 'ChatGPT.exe'), binary: configuredPath};
    }
  }
  if (programFiles) roots.add(path.join(programFiles, 'WindowsApps'));
  for (const root of roots) {
    for (const pkg of await storePackages(root)) {
      const packageDir = path.join(root, pkg.name);
      const desktop = path.join(packageDir, 'app', 'ChatGPT.exe');
      const binary = path.join(packageDir, storeServerPath);
      const [hasDesktop, hasBinary] = await Promise.all([isFile(desktop), isFile(binary)]);
      if (hasDesktop && hasBinary) return {desktop, binary};
    }
  }
  if (registered && await isFile(registered.desktop) && await isFile(registered.binary)) return registered;
  throw Error('找不到完整的 Microsoft Store 版 Codex 桌面安装。');
}

// Desktop-managed binaries move on app updates. Never fall back to the npm CLI.
export async function resolveDesktopBinary(configured, {localAppData = process.env.LOCALAPPDATA} = {}) {
  if(configured && await stat(configured).then(value=>value.isFile(),()=>false))return configured;
  if(configured){
    const configuredPath=path.resolve(configured);
    const resources=path.dirname(configuredPath),app=path.dirname(resources);
    const packageDir=path.dirname(app),windowsApps=path.dirname(packageDir);
    if(path.basename(windowsApps).toLowerCase()==='windowsapps'&&storePackage.test(path.basename(packageDir))&&
       path.relative(packageDir,configuredPath).toLowerCase()===storeServerPath){
      for(const installed of await storePackages(windowsApps)){
        const binary=path.join(windowsApps,installed.name,storeServerPath);
        if(await stat(binary).then(value=>value.isFile(),()=>false))return binary;
      }
      throw Error('未找到已安装的桌面 Codex 程序，请打开桌面 Codex 后重试');
    }
  }
  if(!localAppData)throw Error('桌面 Codex 程序不存在，请重新选择桌面程序路径');
  const root=path.resolve(localAppData,'OpenAI','Codex','bin');
  if(configured){
    const relative=path.relative(root,path.resolve(configured));
    if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||relative.split(path.sep).length!==2||path.basename(relative).toLowerCase()!=='codex.exe')throw Error('指定的桌面 Codex 程序不存在，请在设置中重新选择');
  }
  const rows=await readdir(root,{withFileTypes:true}).catch(()=>[]),found=[];
  for(const row of rows){if(!row.isDirectory())continue;const file=path.join(root,row.name,'codex.exe'),info=await stat(file).catch(()=>null);if(info?.isFile())found.push({file,time:info.mtimeMs});}
  found.sort((a,b)=>b.time-a.time);
  if(!found.length)throw Error('未找到已安装的桌面 Codex 程序，请打开桌面 Codex 后重试');
  return found[0].file;
}
