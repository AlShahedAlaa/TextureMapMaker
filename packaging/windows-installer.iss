; Inno Setup script — Windows installer for Texture Map Maker
; Built by GitHub Actions:  iscc /DMyAppVersion=1.1.0 packaging\windows-installer.iss
; Installs per-user (no admin prompt), adds Start Menu + optional Desktop shortcut.

#ifndef MyAppVersion
  #define MyAppVersion "1.1.0"
#endif
#define MyAppName "Texture Map Maker"
#define MyAppExe "TextureMapMaker.exe"

[Setup]
AppId={{6F3B8E2A-4C1D-4E7B-9A52-7D3C1B9E0A41}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Alaa Al Shahed
AppPublisherURL=https://alaaalshahed.com
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=TextureMapMaker-{#MyAppVersion}-Windows-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#MyAppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\TextureMapMaker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
