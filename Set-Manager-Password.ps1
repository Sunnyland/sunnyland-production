param([string]$Email = 'paul@sunnyland.com.au', [string]$NodeBinary = 'node')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Sunnyland Production - Set your password'
$form.Size = New-Object System.Drawing.Size(540,330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(24,20)
$label.Size = New-Object System.Drawing.Size(480,62)
$label.Text = "Manager account: $Email`r`nChoose a new password of at least 14 characters.`r`nEnter it here, not in ChatGPT."
$form.Controls.Add($label)
$first = New-Object System.Windows.Forms.TextBox
$first.Location = New-Object System.Drawing.Point(24,105)
$first.Size = New-Object System.Drawing.Size(470,25)
$first.UseSystemPasswordChar = $true
$first.MaxLength = 200
$form.Controls.Add($first)
$repeatLabel = New-Object System.Windows.Forms.Label
$repeatLabel.Location = New-Object System.Drawing.Point(24,141)
$repeatLabel.Size = New-Object System.Drawing.Size(470,22)
$repeatLabel.Text = 'Repeat password'
$form.Controls.Add($repeatLabel)
$second = New-Object System.Windows.Forms.TextBox
$second.Location = New-Object System.Drawing.Point(24,166)
$second.Size = New-Object System.Drawing.Size(470,25)
$second.UseSystemPasswordChar = $true
$second.MaxLength = 200
$form.Controls.Add($second)
$save = New-Object System.Windows.Forms.Button
$save.Text = 'Set password'
$save.Location = New-Object System.Drawing.Point(342,220)
$save.Size = New-Object System.Drawing.Size(152,34)
$form.Controls.Add($save)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(24,220)
$cancel.Size = New-Object System.Drawing.Size(90,34)
$cancel.Add_Click({ $form.Close() })
$form.Controls.Add($cancel)
$form.AcceptButton = $save
$form.CancelButton = $cancel
$save.Add_Click({
    if ($first.Text.Length -lt 14 -or $first.Text -cne $second.Text) {
        [System.Windows.Forms.MessageBox]::Show('Use at least 14 characters and enter the same password twice.','Check password') | Out-Null
        return
    }
    $save.Enabled = $false
    try {
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = $NodeBinary
        $info.WorkingDirectory = $PSScriptRoot
        $info.Arguments = '"' + (Join-Path $PSScriptRoot 'provision.mjs') + '" activate'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo = $info
        [void]$child.Start()
        $payload = @{email=$Email;password=$first.Text} | ConvertTo-Json -Compress
        $child.StandardInput.WriteLine($payload)
        $child.StandardInput.Close()
        $payload = $null
        $first.Clear()
        $second.Clear()
        $output = $child.StandardOutput.ReadToEnd()
        $errors = $child.StandardError.ReadToEnd()
        $child.WaitForExit()
        if ($child.ExitCode -ne 0) { throw $errors }
        $result = $output | ConvertFrom-Json
        if (-not $result.enabled) { throw 'Account activation was not confirmed.' }
        [System.Windows.Forms.MessageBox]::Show('Your manager password is saved. Return to ChatGPT so the server connection can be finished.','Account ready') | Out-Null
        $form.Close()
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Setup could not finish') | Out-Null
        $save.Enabled = $true
    }
})
$form.Add_Shown({ $first.Focus() })
[void]$form.ShowDialog()
