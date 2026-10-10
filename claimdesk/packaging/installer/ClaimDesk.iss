; ClaimDesk installer (Inno Setup 6) — design doc §G.4; 0.4 background mode, import folder and claimdesk:// links:
; docs/SUPREME-DESIGN.md §M.2.
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
#define BackgroundExe "ClaimDesk-Background.exe"

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
; Show the welcome page (Inno 6 hides it by default): it carries the "updates in place, data kept" text (0.3 §F.2.3).
DisableWelcomePage=no
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
; Checked by default (§M.2): the agents need ClaimDesk running after the window is closed and after a restart.
Name: "autostart"; Description: "Keep ClaimDesk running in the background (needed for the agents)"; GroupDescription: "Background:"

[Dirs]
; The import folder (§0.3): drop files of any size here. Never removed by an uninstall (it may hold files).
Name: "{localappdata}\ClaimDesk\inbox\evidence"; Flags: uninsneveruninstall
Name: "{localappdata}\ClaimDesk\inbox\intake"; Flags: uninsneveruninstall
Name: "{localappdata}\ClaimDesk\inbox\mail"; Flags: uninsneveruninstall
Name: "{localappdata}\ClaimDesk\inbox\brain-packs"; Flags: uninsneveruninstall
Name: "{localappdata}\ClaimDesk\inbox\engineer-data"; Flags: uninsneveruninstall

[InstallDelete]
; Upgrade in place: replace the program folder wholesale so no stale node_modules files survive. Data is elsewhere.
Type: filesandordirs; Name: "{app}\app"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Flags: runminimized; Comment: "Accident claims - {#Publisher}"; AppUserModelID: "CCGUK.ClaimDesk"
Name: "{autoprograms}\{#AppName} import folder"; Filename: "{localappdata}\ClaimDesk\inbox"; Comment: "Drop big files here (Audatex data, brain packs, large evidence) - ClaimDesk picks them up"
Name: "{autoprograms}\{#AppName} (example claims)"; Filename: "{app}\{#AppExe}"; Parameters: "--demo"; WorkingDir: "{app}"; Flags: runminimized; Comment: "ClaimDesk with example claims (kept apart from your data)"
Name: "{autoprograms}\Stop {#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "--stop"; WorkingDir: "{app}"; Flags: runminimized; Comment: "Stop the running ClaimDesk (your data and the example claims)"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Flags: runminimized; Tasks: desktopicon

[Run]
; Background mode (§M.1): scheduled tasks ClaimDesk\Background (at sign-in) and ClaimDesk\Watchdog (every 15 minutes).
Filename: "{app}\{#AppExe}"; Parameters: "--install-autostart"; WorkingDir: "{app}"; StatusMsg: "Setting ClaimDesk to run in the background..."; Flags: runhidden waituntilterminated; Tasks: autostart
; Start the background server again now (a silent update stopped it; otherwise the Watchdog waits up to 15 minutes).
Filename: "{app}\{#AppExe}"; Parameters: "--ensure"; WorkingDir: "{app}"; Flags: runhidden nowait; Tasks: autostart
; Unticked (e.g. on an upgrade): take the tasks away again.
Filename: "{app}\{#AppExe}"; Parameters: "--remove-autostart"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; Tasks: not autostart
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runminimized

[UninstallRun]
; Remove the scheduled tasks first, so nothing starts ClaimDesk again while it is being removed.
Filename: "{app}\{#AppExe}"; Parameters: "--remove-autostart"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveAutostart"
; Stop ClaimDesk first: the server keeps ClaimDesk.exe and better_sqlite3.node open.
; /T also ends the ClaimDesk app window (Edge started by ClaimDesk), so its profile under the data folder is released.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#AppExe}"; Flags: runhidden; RunOnceId: "StopClaimDesk"
; The background supervisor and its server run as ClaimDesk-Background.exe.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM {#BackgroundExe}"; Flags: runhidden; RunOnceId: "StopClaimDeskBackground"

[Registry]
; claimdesk:// links (Windows notifications, the daily log) open that page in ClaimDesk (launch.cjs --open, §M.1).
Root: HKCU; Subkey: "Software\Classes\claimdesk"; ValueType: string; ValueName: ""; ValueData: "URL:ClaimDesk"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\claimdesk"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\claimdesk\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"",0"
Root: HKCU; Subkey: "Software\Classes\claimdesk\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" --open ""%1"""

[UninstallDelete]
; The program folder only (files the app may have created next to itself). Never the data folder.
Type: filesandordirs; Name: "{app}\app"
Type: dirifempty; Name: "{app}"

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{322DAE75-FC0F-4786-B2BB-62E4A6A3D59B}_is1';

// Next numeric part of a dotted version ('0.3.12' → 0, then 3, then 12); a missing or non-numeric part counts as 0.
function NextVersionPart(var S: String): Integer;
var
  P: Integer;
  Part: String;
begin
  P := Pos('.', S);
  if P > 0 then
  begin
    Part := Copy(S, 1, P - 1);
    Delete(S, 1, P);
  end
  else
  begin
    Part := S;
    S := '';
  end;
  Result := StrToIntDef(Trim(Part), 0);
end;

// Numeric per part: 1 when A is newer than B, -1 when older, 0 when the same.
function ClaimDeskCompareVersions(A, B: String): Integer;
var
  I, X, Y: Integer;
begin
  Result := 0;
  for I := 1 to 4 do
  begin
    X := NextVersionPart(A);
    Y := NextVersionPart(B);
    if X > Y then
    begin
      Result := 1;
      exit;
    end;
    if X < Y then
    begin
      Result := -1;
      exit;
    end;
  end;
end;

// Downgrade guard (0.3 §F.2.3): when a newer ClaimDesk is installed, an interactive setup asks first (default No).
// Silent installs (CI, scripted) carry on. The data folder is never touched either way.
function InitializeSetup(): Boolean;
var
  Installed: String;
begin
  Result := True;
  if not RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', Installed) then
    if not RegQueryStringValue(HKLM, UninstallKey, 'DisplayVersion', Installed) then
      Installed := '';
  if (Installed <> '') and (ClaimDeskCompareVersions(Installed, '{#AppVersion}') > 0) and (not WizardSilent()) then
    Result := MsgBox('ClaimDesk ' + Installed + ' is installed, which is newer than this setup ({#AppVersion}).' + #13#10#13#10 +
                     'Install the older version anyway? Your data is kept either way.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

// Welcome text (0.3 §F.2.3). Set here rather than in [Messages] so %LOCALAPPDATA% is shown literally.
procedure InitializeWizard();
begin
  WizardForm.WelcomeLabel2.Caption :=
    'This will install ' + '{#AppName} {#AppVersion}' + ' on your computer.' + #13#10#13#10 +
    'This updates ClaimDesk in place. Your claims and settings in %LOCALAPPDATA%\ClaimDesk are kept, and a backup of the database is made the first time the new version starts.' + #13#10#13#10 +
    'If ClaimDesk is open, you will be asked to close it first.';
end;

// Is this program running for this user? (find.exe answers 0 when tasklist lists it)
function ImageRunning(Image: String): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{cmd}'), '/C ""' + ExpandConstant('{sys}\tasklist.exe') + '" /FI "IMAGENAME eq ' + Image + '" /NH | "' + ExpandConstant('{sys}\find.exe') + '" /I "' + Image + '""', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// ClaimDesk.exe (the window, or a 0.3-style server) or ClaimDesk-Background.exe (the 0.4 background server).
function ClaimDeskRunning(): Boolean;
begin
  Result := ImageRunning('{#AppExe}') or ImageRunning('{#BackgroundExe}');
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
    // the background supervisor first, or it would restart the server it watches
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM {#BackgroundExe}', '', SW_HIDE, ewWaitUntilTerminated, Code);
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
