$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)

$token = [Convert]::ToBase64String($bytes).TrimEnd("=") -replace "\+", "-" -replace "/", "_"
$serviceKey = "svc_$token"

Write-Output "SERVICE_API_KEY=$serviceKey"
