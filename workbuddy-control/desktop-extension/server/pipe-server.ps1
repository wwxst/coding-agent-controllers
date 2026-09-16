[CmdletBinding()]
param([Parameter(Mandatory)][string]$PipeName)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;

public static class SecurePipeRelay
{
    private sealed class ClientConnection : IDisposable
    {
        public readonly NamedPipeServerStream Pipe;
        public readonly StreamWriter Writer;

        public ClientConnection(NamedPipeServerStream pipe)
        {
            Pipe = pipe;
            Writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true);
        }

        public void Dispose()
        {
            try
            {
                Writer.Dispose();
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
            try
            {
                Pipe.Dispose();
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }

    private static readonly object OutputLock = new object();
    private static readonly ConcurrentDictionary<string, ClientConnection> Clients =
        new ConcurrentDictionary<string, ClientConnection>();

    public static void Run(string pipeName)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Task.Run(() => AcceptLoop(pipeName));
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var separator = line.IndexOf('\t');
            if (separator <= 0) continue;
            var relayId = line.Substring(0, separator);
            ClientConnection client;
            if (!Clients.TryRemove(relayId, out client)) continue;
            using (client)
            {
                try
                {
                    client.Writer.WriteLine(line.Substring(separator + 1));
                    client.Writer.Flush();
                }
                catch (IOException)
                {
                    // The requesting process may exit before WorkBuddy returns its response.
                }
                catch (ObjectDisposedException)
                {
                    // The disconnected client is already closed; the relay remains available.
                }
            }
        }
        foreach (var client in Clients.Values) client.Dispose();
        Clients.Clear();
    }

    private static void AcceptLoop(string pipeName)
    {
        var announced = false;
        while (true)
        {
            var pipe = CreatePipe(pipeName);
            var waiting = pipe.BeginWaitForConnection(null, null);
            if (!announced)
            {
                WriteOutput("READY");
                announced = true;
            }
            pipe.EndWaitForConnection(waiting);
            Task.Run(() => HandleClient(pipe));
        }
    }

    private static NamedPipeServerStream CreatePipe(string pipeName)
    {
        var sid = WindowsIdentity.GetCurrent().User;
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            4096,
            4096,
            security
        );
    }

    private static void HandleClient(NamedPipeServerStream pipe)
    {
        try
        {
            using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
            {
                var request = reader.ReadLine();
                if (request == null)
                {
                    pipe.Dispose();
                    return;
                }
                var relayId = Guid.NewGuid().ToString("N");
                var client = new ClientConnection(pipe);
                if (!Clients.TryAdd(relayId, client))
                {
                    client.Dispose();
                    return;
                }
                WriteOutput(relayId + "\t" + request);
            }
        }
        catch (Exception error)
        {
            pipe.Dispose();
            Console.Error.WriteLine(error.Message);
        }
    }

    private static void WriteOutput(string value)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(value);
            Console.Out.Flush();
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[SecurePipeRelay]::Run($PipeName)
