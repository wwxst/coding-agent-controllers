[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PipePath,
    [switch]$ReadOnly
)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class WorkBuddyPipeSecurity
{
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint OpenExisting = 3;
    private const int SeKernelObject = 6;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint ProtectedDaclSecurityInformation = 0x80000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string name, uint access, uint share, IntPtr securityAttributes,
        uint creationDisposition, uint flags, IntPtr template);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string sddl, uint revision, out IntPtr descriptor, out uint size);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(
        IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetSecurityInfo(
        IntPtr handle, int objectType, uint securityInformation,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(
        IntPtr handle, int objectType, uint securityInformation,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl,
        out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
        IntPtr descriptor, uint revision, uint securityInformation,
        out IntPtr sddl, out uint length);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string ApplyAndRead(string pipePath, string currentSid, bool readOnly)
    {
        uint access = ReadControl | (readOnly ? 0 : WriteDac);
        using (SafeFileHandle handle = CreateFile(pipePath, access, 0, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!readOnly) Apply(handle.DangerousGetHandle(), currentSid);
            return Read(handle.DangerousGetHandle());
        }
    }

    private static void Apply(IntPtr handle, string currentSid)
    {
        IntPtr descriptor;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(
            "D:P(A;;GA;;;" + currentSid + ")", 1, out descriptor, out size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            bool present;
            bool defaulted;
            IntPtr dacl;
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint error = SetSecurityInfo(
                handle, SeKernelObject,
                DaclSecurityInformation | ProtectedDaclSecurityInformation,
                IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error);
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    private static string Read(IntPtr handle)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint error = GetSecurityInfo(
            handle, SeKernelObject, DaclSecurityInformation,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try
        {
            IntPtr text;
            uint length;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptor(
                descriptor, 1, DaclSecurityInformation, out text, out length))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return Marshal.PtrToStringUni(text); }
            finally { LocalFree(text); }
        }
        finally
        {
            LocalFree(descriptor);
        }
    }
}
'@

Add-Type -TypeDefinition $source
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = [WorkBuddyPipeSecurity]::ApplyAndRead($PipePath, $currentSid, [bool]$ReadOnly)
$descriptor = New-Object Security.AccessControl.CommonSecurityDescriptor($false, $false, $sddl)
$aceSids = @($descriptor.DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value })
[ordered]@{ currentSid = $currentSid; sddl = $sddl; aceSids = $aceSids } | ConvertTo-Json -Compress
