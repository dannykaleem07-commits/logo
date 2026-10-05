; ClaimDesk installer (Inno Setup 6) — design doc §G.4.
; Build (CI does this; see packaging/README-desktop.md):
;   iscc /Qp /DAppVersion=0.2.57 /DSourceDir=<abs>\packaging\dist\ClaimDesk /O<abs>\packaging\dist packaging\installer\ClaimDesk.iss
; Per-user install, no administrator rights: %LOCALAPPDATA%\Programs\ClaimDesk.
; Data stays in %LOCALAPPDATA%\ClaimDesk (launch.cjs homeDir()); upgrades and uninstalls never touch it unless the
; user answers Yes to the uninstall question (silent uninstalls never delete it).

#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\ClaimDesk"
#endif
#define AppName "ClaimDesk"
#define Publisher "Courtesy Cars Group UK Ltd"
#define AppExe "ClaimDesk.exe"

[Setup]
; NEVER change AppId once released: upgrades find the previous install by it.
AppId={{322DAE75-FC0F-4786-B2BB-62E4A6A3D59B}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL=https://www.courtesycars.net
AppSupportURL=https://www.courtesycars.net
AppUpdatesURL=https://www.courtesycars.net
AppContact=claims@courtesycars.net
AppSupportPhone=020 7052 5403
AppComments=Accident claims, credit hire, recovery and storage case management. {#Publisher}, registered in England and Wales No. 17430389, 44 Syon Lane, Isleworth, London TW7 5NQ.
AppCopyright=Copyright (C) 2026 {#Publisher}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductVersion={#AppVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoCompany={#Publisher}
VersionInfoProductName={#AppName}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup - {#Publisher}
VersionInfoCopyright=Copyright (C) 2026 {#Publisher}
; per user, no UAC prompt; {autopf} = %LOCALAPPDATA%\Programs in this mode
PrivilegesRequired=lowest
; /CURRENTUSER (used by CI) is accepted on the command line; the wizard never offers an all-users install
PrivilegesRequiredOverridesAllowed=commandline
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
UsePreviousAppDir=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
OutputBaseFilename=ClaimDesk-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
CloseApplications=force
CloseApplicationsFilter=*.exe,*.dll,*.node
RestartApplications=no
SetupLogging=yes
; Code signing (design doc §G.8): needs a certificate. Define a sign tool named "claimdesk" in ISCC
; (iscc "/Sclaimdesk=signtool.exe sign /f $qcert.pfx$q /p <password> /fd sha256 /tr http://timestamp.digicert.com /td sha256 $f")
; and uncomment the next line; until then Windows shows "Unknown publisher".
; SignTool=claimdesk
; SignedUninstaller=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[InstallDelete]
; Upgrade in place: replace the program folder wholesale so no stale node_modules files survive. Data is elsewhere.
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Flags: runminimized; Comment: "Accident claims - {#Publisher}"
Name: "{autoprograms}\{#AppName} (example claims)"; Filename: "{app}\{#AppExe}"; Parameters: "--demo"; WorkingDir: "{app}"; Flags: runminimized; Comment: "ClaimDesk with example claims (kept apart from your data)"
Name: "{autoprograms}\Stop {#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--stop"; WorkingDir: "{app}"; Flags: runminimized; Comment: "Stop the running ClaimDesk (your data and the example claims)"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runminimized

[UninstallRun]
; Stop ClaimDesk first: the server keeps ClaimDesk.exe and better_sqlite3.node open.
; /T also ends the ClaimDesk app window (Edge started by ClaimDesk), so its profile under the data folder is released.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#AppExe}"; Flags: runhidden; RunOnceId: "StopClaimDesk"

[UninstallDelete]
; The program folder only (files the app may have created next to itself). Never the data folder.
Type: filesandordirs; Name: "{app}\app"
Type: dirifempty; Name: "{app}"

[Code]
// Is ClaimDesk.exe running for this user? (find.exe answers 0 when tasklist lists it)
function ClaimDeskRunning(): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/C ""' + ExpandConstant('{sys}\tasklist.exe') + '" /FI "IMAGENAME eq {#AppExe}" /NH | "' + ExpandConstant('{sys}\find.exe') + '" /I "{#AppExe}""', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// Stop a running ClaimDesk before files are replaced (upgrade in place). Interactive installs ask first, so nothing
// typed is lost without warning; /T also ends the ClaimDesk app window so no orphan window keeps the old version open.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if ClaimDeskRunning() then
  begin
    if not WizardSilent() then
      if MsgBox('ClaimDesk is running and will be closed to update it.' + #13#10#13#10 + 'Save any open work in ClaimDesk, then click OK. Click Cancel to update later.', mbConfirmation, MB_OKCANCEL) <> IDOK then
      begin
        Result := 'ClaimDesk is still running. Close it (Start menu > Stop ClaimDesk), then run the installer again.';
        exit;
      end;
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM {#AppExe}', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(800);
  end;
end;

// Uninstall keeps %LOCALAPPDATA%\ClaimDesk (claims, evidence, documents, settings). Optional prompt, default No;
// a silent uninstall never deletes it.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\ClaimDesk');
    if DirExists(DataDir) and (not UninstallSilent) then
      if MsgBox('Also delete your ClaimDesk data (claims, evidence, documents and settings) in ' + DataDir + '?' + #13#10#13#10 +
                'Choose No to keep it for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
