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
DisableProgramGroupPage=yes
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no
SetupLogging=yes
AppPublisherURL=https://github.com/dannykaleem07-commits/logo
AppSupportURL=https://github.com/dannykaleem07-commits/logo/blob/main/callpilot/README.md
AppUpdatesURL=https://github.com/dannykaleem07-commits/logo/releases/tag/callpilot-latest
VersionInfoDescription=CallPilot – live call assistant
UninstallDisplayName=CallPilot

[Messages]
WelcomeLabel1=Welcome to CallPilot
WelcomeLabel2=This installs CallPilot on your computer.%n%nCallPilot listens to your calls, writes down what is said and shows you what to say next. On first launch a four-step setup asks for your AI key, speech engine and which app to listen to.%n%nClick Next to continue.
FinishedLabel=CallPilot is installed. Click Finish to launch it – the setup assistant will guide you through the AI key and audio.

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start CallPilot when Windows starts (sits in the tray, ready for the next call)"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "..\dist\CallPilot.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\CallPilot"; Filename: "{app}\CallPilot.exe"
Name: "{group}\Uninstall CallPilot"; Filename: "{uninstallexe}"
Name: "{autodesktop}\CallPilot"; Filename: "{app}\CallPilot.exe"; Tasks: desktopicon
Name: "{userstartup}\CallPilot"; Filename: "{app}\CallPilot.exe"; Tasks: startup

[Run]
Filename: "{app}\CallPilot.exe"; Description: "Launch CallPilot"; Flags: nowait postinstall skipifsilent
