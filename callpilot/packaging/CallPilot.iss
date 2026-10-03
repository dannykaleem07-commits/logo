; Inno Setup script - builds CallPilot-Setup.exe (Start menu + desktop shortcut + uninstaller)
#define AppVersion GetEnv("CALLPILOT_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{D0BD1BA3-26BA-4911-B38D-F2268446C3F7}
AppName=CallPilot
AppVersion={#AppVersion}
AppPublisher=CallPilot
DefaultDirName={autopf}\CallPilot
DefaultGroupName=CallPilot
OutputDir=..\dist
OutputBaseFilename=CallPilot-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\CallPilot.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
MinVersion=10.0.19041

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\CallPilot.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\CallPilot"; Filename: "{app}\CallPilot.exe"
Name: "{group}\Uninstall CallPilot"; Filename: "{uninstallexe}"
Name: "{autodesktop}\CallPilot"; Filename: "{app}\CallPilot.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\CallPilot.exe"; Description: "Launch CallPilot"; Flags: nowait postinstall skipifsilent
