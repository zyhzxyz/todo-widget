param(
    [switch]$SmokeTest
)

$ErrorActionPreference = "Stop"

if (-not $SmokeTest -and $PSCommandPath -and [System.Threading.Thread]::CurrentThread.GetApartmentState() -ne "STA") {
    $quotedPath = '"' + $PSCommandPath + '"'
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -File $quotedPath" -WindowStyle Hidden
    return
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml

if (-not [string]::IsNullOrWhiteSpace($env:TODO_WIDGET_HOME)) {
    $script:AppDir = $env:TODO_WIDGET_HOME
}
elseif ($SmokeTest) {
    $script:AppDir = Join-Path $PSScriptRoot ".runtime"
}
else {
    $script:AppDir = Join-Path $env:APPDATA "TodoWidget"
}
$script:TodosPath = Join-Path $script:AppDir "todos.json"
$script:SettingsPath = Join-Path $script:AppDir "settings.json"
$null = New-Item -ItemType Directory -Force -Path $script:AppDir

$script:BrushConverter = New-Object System.Windows.Media.BrushConverter
$script:Todos = @()
$script:Filter = "all"
$script:Window = $null

function New-Brush {
    param([string]$Color)
    return $script:BrushConverter.ConvertFromString($Color)
}

function Get-NowIso {
    return (Get-Date).ToString("o")
}

function U {
    param([int[]]$Codes)
    return -join ($Codes | ForEach-Object { [char]$_ })
}

function New-Todo {
    param(
        [string]$Title,
        [string]$Priority = "normal",
        [string]$DueDate = "",
        [bool]$Completed = $false
    )

    $now = Get-NowIso
    return [pscustomobject]@{
        id = [guid]::NewGuid().ToString("N")
        title = $Title
        completed = $Completed
        priority = $Priority
        dueDate = $DueDate
        createdAt = $now
        updatedAt = $now
    }
}

function Get-DefaultTodos {
    $today = (Get-Date).ToString("yyyy-MM-dd")
    return @(
        (New-Todo -Title (U @(0x9879, 0x76EE, 0x7BA1, 0x7406, 0x65B0, 0x4EFB, 0x52A1)) -Priority "normal" -DueDate $today),
        (New-Todo -Title (U @(0x4E3A, 0x9879, 0x76EE, 0x7EC4, 0x91C7, 0x8D2D, 0x8BBE, 0x5907)) -Priority "high"),
        (New-Todo -Title (U @(0x5B8C, 0x6210, 0x6570, 0x636E, 0x5B89, 0x5168, 0x5408, 0x89C4, 0x6027, 0x81EA, 0x67E5)) -Priority "low" -Completed $true),
        (New-Todo -Title (U @(0x9884, 0x7B97, 0x7F16, 0x5236, 0xFF1A, 0x5236, 0x5B9A, 0x5B63, 0x5EA6, 0x90E8, 0x95E8, 0x9884, 0x7B97)) -Priority "normal"),
        (New-Todo -Title (U @(0x529E, 0x516C, 0x533A, 0x6253, 0x5370, 0x673A, 0x7EF4, 0x62A4, 0x4E0E, 0x8017, 0x6750, 0x66F4, 0x6362)) -Priority "low" -Completed $true)
    )
}

function Get-DefaultSettings {
    $screenWidth = [System.Windows.SystemParameters]::PrimaryScreenWidth
    $left = [Math]::Max(24, [double]$screenWidth - 380)

    return [pscustomobject]@{
        left = $left
        top = 120
        width = 320
        height = 560
        previousHeight = 560
        alwaysOnTop = $true
        locked = $false
        collapsed = $false
        filter = "all"
    }
}

function Read-JsonArray {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($json)) {
        return @()
    }

    $parsed = $json | ConvertFrom-Json
    if ($null -eq $parsed) {
        return @()
    }

    return @($parsed)
}

function Load-Settings {
    $settings = Get-DefaultSettings

    if (Test-Path -LiteralPath $script:SettingsPath) {
        $json = Get-Content -LiteralPath $script:SettingsPath -Raw -Encoding UTF8
        if (-not [string]::IsNullOrWhiteSpace($json)) {
            $loaded = $json | ConvertFrom-Json
            foreach ($name in $settings.PSObject.Properties.Name) {
                if ($loaded.PSObject.Properties.Name -contains $name -and $null -ne $loaded.$name) {
                    $settings.$name = $loaded.$name
                }
            }
        }
    }

    return $settings
}

function Load-Todos {
    $items = Read-JsonArray -Path $script:TodosPath
    if ($items.Count -eq 0) {
        return Get-DefaultTodos
    }

    foreach ($item in $items) {
        if (-not ($item.PSObject.Properties.Name -contains "priority")) {
            Add-Member -InputObject $item -MemberType NoteProperty -Name priority -Value "normal"
        }
        if (-not ($item.PSObject.Properties.Name -contains "dueDate")) {
            Add-Member -InputObject $item -MemberType NoteProperty -Name dueDate -Value ""
        }
    }

    return $items
}

function Save-Todos {
    $script:Todos | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:TodosPath -Encoding UTF8
}

function Save-Settings {
    if ($null -eq $script:Window) {
        return
    }

    $script:Settings.left = [Math]::Round($script:Window.Left, 0)
    $script:Settings.top = [Math]::Round($script:Window.Top, 0)
    $script:Settings.width = [Math]::Round($script:Window.Width, 0)
    if (-not [bool]$script:Settings.collapsed) {
        $script:Settings.height = [Math]::Round($script:Window.Height, 0)
        $script:Settings.previousHeight = $script:Settings.height
    }
    $script:Settings.alwaysOnTop = [bool]$script:Window.Topmost
    $script:Settings.filter = $script:Filter

    $script:Settings | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:SettingsPath -Encoding UTF8
}

function Get-PriorityColor {
    param([string]$Priority)

    switch ($Priority) {
        "high" { return "#FFFF6B6B" }
        "low" { return "#FF62C273" }
        default { return "#FF26B7C8" }
    }
}

function Get-PriorityLabel {
    param([string]$Priority)

    switch ($Priority) {
        "high" { return (U @(0x91CD, 0x8981)) }
        "low" { return (U @(0x4F4E, 0x4F18, 0x5148, 0x7EA7)) }
        default { return (U @(0x666E, 0x901A)) }
    }
}

function Get-VisibleTodos {
    $today = (Get-Date).ToString("yyyy-MM-dd")

    switch ($script:Filter) {
        "today" { return @($script:Todos | Where-Object { $_.dueDate -eq $today -and -not [bool]$_.completed }) }
        "important" { return @($script:Todos | Where-Object { $_.priority -eq "high" -and -not [bool]$_.completed }) }
        "done" { return @($script:Todos | Where-Object { [bool]$_.completed }) }
        default { return @($script:Todos) }
    }
}

function Set-FilterButtonState {
    param(
        [System.Windows.Controls.Button]$Button,
        [bool]$Active
    )

    if ($Active) {
        $Button.Background = New-Brush "#38FFFFFF"
        $Button.Foreground = New-Brush "#FFFFFFFF"
    }
    else {
        $Button.Background = New-Brush "#00FFFFFF"
        $Button.Foreground = New-Brush "#B8FFFFFF"
    }
}

function Update-FilterButtons {
    Set-FilterButtonState -Button $script:AllFilterButton -Active ($script:Filter -eq "all")
    Set-FilterButtonState -Button $script:TodayFilterButton -Active ($script:Filter -eq "today")
    Set-FilterButtonState -Button $script:ImportantFilterButton -Active ($script:Filter -eq "important")
    Set-FilterButtonState -Button $script:DoneFilterButton -Active ($script:Filter -eq "done")
}

function Update-ChromeState {
    if ([bool]$script:Settings.locked) {
        $script:Header.Cursor = [System.Windows.Input.Cursors]::Arrow
        $script:LockButton.Content = [char]0x9501
        $script:LockButton.Background = New-Brush "#36FFFFFF"
        $script:LockButton.ToolTip = U @(0x5DF2, 0x9501, 0x5B9A, 0x4F4D, 0x7F6E)
    }
    else {
        $script:Header.Cursor = [System.Windows.Input.Cursors]::SizeAll
        $script:LockButton.Content = [char]0x5F00
        $script:LockButton.Background = New-Brush "#00FFFFFF"
        $script:LockButton.ToolTip = U @(0x62D6, 0x52A8, 0x9876, 0x90E8, 0x53EF, 0x79FB, 0x52A8)
    }

    if ([bool]$script:Window.Topmost) {
        $script:PinButton.Background = New-Brush "#36FFFFFF"
        $script:PinButton.ToolTip = U @(0x53D6, 0x6D88, 0x7F6E, 0x9876)
    }
    else {
        $script:PinButton.Background = New-Brush "#00FFFFFF"
        $script:PinButton.ToolTip = U @(0x7F6E, 0x9876, 0x663E, 0x793A)
    }
}

function Set-CollapsedState {
    param([bool]$Collapsed)

    $script:Settings.collapsed = $Collapsed

    if ($Collapsed) {
        if ($script:Window.Height -gt 120) {
            $script:Settings.previousHeight = [Math]::Round($script:Window.Height, 0)
        }
        $script:QuickAddPanel.Visibility = [System.Windows.Visibility]::Collapsed
        $script:Divider.Visibility = [System.Windows.Visibility]::Collapsed
        $script:ListScroller.Visibility = [System.Windows.Visibility]::Collapsed
        $script:Footer.Visibility = [System.Windows.Visibility]::Collapsed
        $script:Window.ResizeMode = [System.Windows.ResizeMode]::NoResize
        $script:Window.Height = 58
        $script:CollapseButton.Content = "+"
        $script:CollapseButton.ToolTip = U @(0x5C55, 0x5F00)
    }
    else {
        $script:Divider.Visibility = [System.Windows.Visibility]::Visible
        $script:ListScroller.Visibility = [System.Windows.Visibility]::Visible
        $script:Footer.Visibility = [System.Windows.Visibility]::Visible
        $script:Window.ResizeMode = [System.Windows.ResizeMode]::CanResizeWithGrip
        $height = [double]$script:Settings.previousHeight
        if ($height -lt 300) {
            $height = [double]$script:Settings.height
        }
        if ($height -lt 300) {
            $height = 560
        }
        $script:Window.Height = $height
        $script:CollapseButton.Content = "-"
        $script:CollapseButton.ToolTip = U @(0x6298, 0x53E0)
    }

    Save-Settings
}

function Set-Filter {
    param([string]$Name)

    $script:Filter = $Name
    Update-FilterButtons
    Render-Todos
    Save-Settings
}

function Add-TodoFromInput {
    $title = $script:NewTaskText.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($title)) {
        $script:NewTaskText.Focus() | Out-Null
        return
    }

    $priority = "normal"
    switch ($script:PriorityBox.SelectedIndex) {
        0 { $priority = "low" }
        2 { $priority = "high" }
    }

    $dueDate = ""
    if ([bool]$script:DueTodayBox.IsChecked) {
        $dueDate = (Get-Date).ToString("yyyy-MM-dd")
    }

    $newItem = New-Todo -Title $title -Priority $priority -DueDate $dueDate
    $script:Todos = @($newItem) + @($script:Todos)
    $script:NewTaskText.Clear()
    $script:DueTodayBox.IsChecked = $false
    $script:QuickAddPanel.Visibility = [System.Windows.Visibility]::Collapsed
    Save-Todos
    Render-Todos
}

function Toggle-Todo {
    param([string]$Id)

    $todo = $script:Todos | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if ($null -eq $todo) {
        return
    }

    $todo.completed = -not [bool]$todo.completed
    $todo.updatedAt = Get-NowIso
    Save-Todos
    Render-Todos
}

function Remove-Todo {
    param([string]$Id)

    $script:Todos = @($script:Todos | Where-Object { $_.id -ne $Id })
    Save-Todos
    Render-Todos
}

function New-TaskRow {
    param($Todo)

    $rowBorder = New-Object System.Windows.Controls.Border
    $rowBorder.Margin = New-Object System.Windows.Thickness -ArgumentList 0, 0, 0, 6
    $rowBorder.Padding = New-Object System.Windows.Thickness -ArgumentList 6, 5, 4, 5
    $rowBorder.CornerRadius = New-Object System.Windows.CornerRadius -ArgumentList 8
    $rowBorder.Background = New-Brush "#16FFFFFF"

    $grid = New-Object System.Windows.Controls.Grid
    $colToggle = New-Object System.Windows.Controls.ColumnDefinition
    $colToggle.Width = New-Object System.Windows.GridLength -ArgumentList 28
    $colText = New-Object System.Windows.Controls.ColumnDefinition
    $colText.Width = New-Object System.Windows.GridLength -ArgumentList 1, ([System.Windows.GridUnitType]::Star)
    $colDelete = New-Object System.Windows.Controls.ColumnDefinition
    $colDelete.Width = New-Object System.Windows.GridLength -ArgumentList 24
    $grid.ColumnDefinitions.Add($colToggle)
    $grid.ColumnDefinitions.Add($colText)
    $grid.ColumnDefinitions.Add($colDelete)

    $toggle = New-Object System.Windows.Controls.Button
    $toggle.Width = 22
    $toggle.Height = 22
    $toggle.Padding = New-Object System.Windows.Thickness -ArgumentList 0
    $toggle.Margin = New-Object System.Windows.Thickness -ArgumentList 0, 1, 4, 0
    $toggle.Background = [System.Windows.Media.Brushes]::Transparent
    $toggle.BorderBrush = [System.Windows.Media.Brushes]::Transparent
    $toggle.BorderThickness = New-Object System.Windows.Thickness -ArgumentList 0
    $toggle.Cursor = [System.Windows.Input.Cursors]::Hand
    $toggle.FontSize = 16
    $toggle.Tag = $Todo.id
    $toggle.Content = if ([bool]$Todo.completed) { [char]0x2713 } else { [char]0x25CB }
    $toggle.Foreground = New-Brush (Get-PriorityColor -Priority $Todo.priority)
    $toggle.ToolTip = if ([bool]$Todo.completed) { U @(0x6807, 0x8BB0, 0x4E3A, 0x672A, 0x5B8C, 0x6210) } else { U @(0x6807, 0x8BB0, 0x4E3A, 0x5B8C, 0x6210) }
    $toggle.Add_Click({
        param($sender, $eventArgs)
        Toggle-Todo -Id ([string]$sender.Tag)
    })
    [System.Windows.Controls.Grid]::SetColumn($toggle, 0)

    $textPanel = New-Object System.Windows.Controls.StackPanel
    $textPanel.Orientation = [System.Windows.Controls.Orientation]::Vertical

    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = [string]$Todo.title
    $title.TextWrapping = [System.Windows.TextWrapping]::Wrap
    $title.FontFamily = New-Object System.Windows.Media.FontFamily -ArgumentList "Microsoft YaHei UI"
    $title.FontSize = 12.5
    $title.LineHeight = 18
    $title.Foreground = New-Brush "#E8FFFFFF"
    if ([bool]$Todo.completed) {
        $title.Opacity = 0.46
        $title.TextDecorations = [System.Windows.TextDecorations]::Strikethrough
    }
    $null = $textPanel.Children.Add($title)

    $metaParts = @()
    if (-not [string]::IsNullOrWhiteSpace([string]$Todo.dueDate)) {
        $metaParts += $Todo.dueDate
    }
    if ($Todo.priority -ne "normal") {
        $metaParts += (Get-PriorityLabel -Priority $Todo.priority)
    }

    if ($metaParts.Count -gt 0) {
        $meta = New-Object System.Windows.Controls.TextBlock
        $meta.Text = ($metaParts -join " - ")
        $meta.Margin = New-Object System.Windows.Thickness -ArgumentList 0, 2, 0, 0
        $meta.FontSize = 10.5
        $meta.Foreground = New-Brush "#86FFFFFF"
        $null = $textPanel.Children.Add($meta)
    }
    [System.Windows.Controls.Grid]::SetColumn($textPanel, 1)

    $delete = New-Object System.Windows.Controls.Button
    $delete.Width = 20
    $delete.Height = 22
    $delete.Padding = New-Object System.Windows.Thickness -ArgumentList 0
    $delete.Background = [System.Windows.Media.Brushes]::Transparent
    $delete.BorderBrush = [System.Windows.Media.Brushes]::Transparent
    $delete.BorderThickness = New-Object System.Windows.Thickness -ArgumentList 0
    $delete.Cursor = [System.Windows.Input.Cursors]::Hand
    $delete.Content = [char]0x00D7
    $delete.FontSize = 14
    $delete.Foreground = New-Brush "#8CFFFFFF"
    $delete.Tag = $Todo.id
    $delete.ToolTip = U @(0x5220, 0x9664)
    $delete.Add_Click({
        param($sender, $eventArgs)
        Remove-Todo -Id ([string]$sender.Tag)
    })
    [System.Windows.Controls.Grid]::SetColumn($delete, 2)

    $null = $grid.Children.Add($toggle)
    $null = $grid.Children.Add($textPanel)
    $null = $grid.Children.Add($delete)
    $rowBorder.Child = $grid

    return $rowBorder
}

function Render-Todos {
    $script:TaskList.Children.Clear()
    $items = Get-VisibleTodos

    if ($items.Count -eq 0) {
        $empty = New-Object System.Windows.Controls.TextBlock
        $empty.Text = U @(0x6CA1, 0x6709, 0x5F85, 0x529E, 0x4E8B, 0x9879)
        $empty.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
        $empty.Margin = New-Object System.Windows.Thickness -ArgumentList 0, 34, 0, 0
        $empty.FontSize = 13
        $empty.Foreground = New-Brush "#92FFFFFF"
        $null = $script:TaskList.Children.Add($empty)
    }
    else {
        foreach ($todo in $items) {
            $null = $script:TaskList.Children.Add((New-TaskRow -Todo $todo))
        }
    }

    $openCount = @($script:Todos | Where-Object { -not [bool]$_.completed }).Count
    $doneCount = @($script:Todos | Where-Object { [bool]$_.completed }).Count
    $script:StatusText.Text = ("{0} " + (U @(0x672A, 0x5B8C, 0x6210)) + " / {1} " + (U @(0x5DF2, 0x5B8C, 0x6210))) -f $openCount, $doneCount
}

$script:Settings = Load-Settings
$script:Todos = @(Load-Todos)
$script:Filter = [string]$script:Settings.filter
if ([string]::IsNullOrWhiteSpace($script:Filter)) {
    $script:Filter = "all"
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Todo Widget"
        Width="320"
        Height="560"
        MinWidth="270"
        MinHeight="300"
        AllowsTransparency="True"
        WindowStyle="None"
        ResizeMode="CanResizeWithGrip"
        ShowInTaskbar="False"
        Background="Transparent"
        FontFamily="Microsoft YaHei UI"
        TextOptions.TextFormattingMode="Display"
        TextOptions.TextRenderingMode="ClearType">
    <Window.Resources>
        <Style x:Key="ChromeButton" TargetType="{x:Type Button}">
            <Setter Property="MinWidth" Value="24"/>
            <Setter Property="Height" Value="24"/>
            <Setter Property="Padding" Value="6,0"/>
            <Setter Property="Foreground" Value="#D8FFFFFF"/>
            <Setter Property="Background" Value="#00FFFFFF"/>
            <Setter Property="BorderBrush" Value="#00FFFFFF"/>
            <Setter Property="BorderThickness" Value="0"/>
            <Setter Property="FontSize" Value="12"/>
            <Setter Property="Cursor" Value="Hand"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="{x:Type Button}">
                        <Border Background="{TemplateBinding Background}"
                                BorderBrush="{TemplateBinding BorderBrush}"
                                BorderThickness="{TemplateBinding BorderThickness}"
                                CornerRadius="7"
                                SnapsToDevicePixels="True">
                            <ContentPresenter HorizontalAlignment="Center"
                                              VerticalAlignment="Center"
                                              RecognizesAccessKey="True"/>
                        </Border>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Window.Resources>

    <Border x:Name="Shell"
            CornerRadius="16"
            Background="#B51D2734"
            BorderBrush="#38FFFFFF"
            BorderThickness="1"
            Padding="11">
        <Border.Effect>
            <DropShadowEffect Color="#000000" BlurRadius="26" ShadowDepth="0" Opacity="0.34"/>
        </Border.Effect>

        <Grid>
            <Grid.RowDefinitions>
                <RowDefinition Height="34"/>
                <RowDefinition Height="Auto"/>
                <RowDefinition Height="1"/>
                <RowDefinition Height="*"/>
                <RowDefinition Height="30"/>
            </Grid.RowDefinitions>

            <Grid x:Name="Header" Grid.Row="0" Background="Transparent" Cursor="SizeAll">
                <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="*"/>
                    <ColumnDefinition Width="Auto"/>
                </Grid.ColumnDefinitions>

                <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                    <Button x:Name="AllFilterButton" Style="{StaticResource ChromeButton}" Content="&#x5168;&#x90E8;" ToolTip="&#x5168;&#x90E8;&#x4EFB;&#x52A1;"/>
                    <Button x:Name="TodayFilterButton" Style="{StaticResource ChromeButton}" Content="&#x4ECA;&#x5929;" ToolTip="&#x4ECA;&#x5929;&#x4EFB;&#x52A1;" Margin="2,0,0,0"/>
                    <Button x:Name="ImportantFilterButton" Style="{StaticResource ChromeButton}" Content="&#x91CD;&#x8981;" ToolTip="&#x91CD;&#x8981;&#x4EFB;&#x52A1;" Margin="2,0,0,0"/>
                    <Button x:Name="DoneFilterButton" Style="{StaticResource ChromeButton}" Content="&#x5B8C;&#x6210;" ToolTip="&#x5DF2;&#x5B8C;&#x6210;" Margin="2,0,0,0"/>
                </StackPanel>

                <StackPanel Grid.Column="1" Orientation="Horizontal" HorizontalAlignment="Right" VerticalAlignment="Center">
                    <Button x:Name="AddButton" Style="{StaticResource ChromeButton}" Content="+" ToolTip="&#x6DFB;&#x52A0;&#x4EFB;&#x52A1;"/>
                    <Button x:Name="PinButton" Style="{StaticResource ChromeButton}" Content="&#x9876;" ToolTip="&#x7F6E;&#x9876;&#x663E;&#x793A;" Margin="2,0,0,0"/>
                    <Button x:Name="LockButton" Style="{StaticResource ChromeButton}" Content="&#x5F00;" ToolTip="&#x62D6;&#x52A8;&#x9876;&#x90E8;&#x53EF;&#x79FB;&#x52A8;" Margin="2,0,0,0"/>
                    <Button x:Name="CollapseButton" Style="{StaticResource ChromeButton}" Content="-" ToolTip="&#x6298;&#x53E0;" Margin="2,0,0,0"/>
                    <Button x:Name="CloseButton" Style="{StaticResource ChromeButton}" Content="&#x00D7;" ToolTip="&#x5173;&#x95ED;" Margin="2,0,0,0"/>
                </StackPanel>
            </Grid>

            <Border x:Name="QuickAddPanel"
                    Grid.Row="1"
                    Visibility="Collapsed"
                    Margin="0,6,0,8"
                    Padding="8"
                    CornerRadius="10"
                    Background="#20FFFFFF"
                    BorderBrush="#24FFFFFF"
                    BorderThickness="1">
                <Grid>
                    <Grid.RowDefinitions>
                        <RowDefinition Height="Auto"/>
                        <RowDefinition Height="Auto"/>
                    </Grid.RowDefinitions>

                    <TextBox x:Name="NewTaskText"
                             Grid.Row="0"
                             MinHeight="30"
                             Padding="8,5"
                             Background="#35FFFFFF"
                             Foreground="#FFFFFFFF"
                             BorderBrush="#2EFFFFFF"
                             BorderThickness="1"
                             CaretBrush="#FFFFFFFF"
                             FontSize="12.5"/>

                    <Grid Grid.Row="1" Margin="0,8,0,0">
                        <Grid.ColumnDefinitions>
                            <ColumnDefinition Width="88"/>
                            <ColumnDefinition Width="*"/>
                            <ColumnDefinition Width="Auto"/>
                            <ColumnDefinition Width="Auto"/>
                        </Grid.ColumnDefinitions>

                        <ComboBox x:Name="PriorityBox"
                                  Grid.Column="0"
                                  Height="28"
                                  SelectedIndex="1"
                                  FontSize="12">
                            <ComboBoxItem Content="&#x4F4E;"/>
                            <ComboBoxItem Content="&#x666E;&#x901A;"/>
                            <ComboBoxItem Content="&#x91CD;&#x8981;"/>
                        </ComboBox>

                        <CheckBox x:Name="DueTodayBox"
                                  Grid.Column="1"
                                  Content="&#x4ECA;&#x5929;"
                                  VerticalAlignment="Center"
                                  Foreground="#D8FFFFFF"
                                  Margin="10,0,0,0"/>

                        <Button x:Name="CancelNewTaskButton"
                                Grid.Column="2"
                                Style="{StaticResource ChromeButton}"
                                Content="&#x53D6;&#x6D88;"
                                Margin="4,0,0,0"/>

                        <Button x:Name="SaveNewTaskButton"
                                Grid.Column="3"
                                Style="{StaticResource ChromeButton}"
                                Content="&#x6DFB;&#x52A0;"
                                Background="#3FFFFFFF"
                                Margin="4,0,0,0"/>
                    </Grid>
                </Grid>
            </Border>

            <Border x:Name="Divider" Grid.Row="2" Background="#2AFFFFFF"/>

            <ScrollViewer x:Name="ListScroller"
                          Grid.Row="3"
                          Margin="0,8,0,6"
                          VerticalScrollBarVisibility="Auto"
                          HorizontalScrollBarVisibility="Disabled"
                          Background="Transparent">
                <StackPanel x:Name="TaskList"/>
            </ScrollViewer>

            <Grid x:Name="Footer" Grid.Row="4">
                <TextBlock x:Name="StatusText"
                           VerticalAlignment="Center"
                           Foreground="#98FFFFFF"
                           FontSize="11"/>
                <TextBlock Text="&#x5F85;&#x529E;&#x6E05;&#x5355;"
                           HorizontalAlignment="Right"
                           VerticalAlignment="Center"
                           Foreground="#66FFFFFF"
                           FontSize="11"/>
            </Grid>
        </Grid>
    </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$script:Window = [Windows.Markup.XamlReader]::Load($reader)

$script:Header = $script:Window.FindName("Header")
$script:AllFilterButton = $script:Window.FindName("AllFilterButton")
$script:TodayFilterButton = $script:Window.FindName("TodayFilterButton")
$script:ImportantFilterButton = $script:Window.FindName("ImportantFilterButton")
$script:DoneFilterButton = $script:Window.FindName("DoneFilterButton")
$script:AddButton = $script:Window.FindName("AddButton")
$script:PinButton = $script:Window.FindName("PinButton")
$script:LockButton = $script:Window.FindName("LockButton")
$script:CollapseButton = $script:Window.FindName("CollapseButton")
$script:CloseButton = $script:Window.FindName("CloseButton")
$script:QuickAddPanel = $script:Window.FindName("QuickAddPanel")
$script:NewTaskText = $script:Window.FindName("NewTaskText")
$script:PriorityBox = $script:Window.FindName("PriorityBox")
$script:DueTodayBox = $script:Window.FindName("DueTodayBox")
$script:SaveNewTaskButton = $script:Window.FindName("SaveNewTaskButton")
$script:CancelNewTaskButton = $script:Window.FindName("CancelNewTaskButton")
$script:Divider = $script:Window.FindName("Divider")
$script:ListScroller = $script:Window.FindName("ListScroller")
$script:TaskList = $script:Window.FindName("TaskList")
$script:Footer = $script:Window.FindName("Footer")
$script:StatusText = $script:Window.FindName("StatusText")

$script:Window.Left = [double]$script:Settings.left
$script:Window.Top = [double]$script:Settings.top
$script:Window.Width = [Math]::Max(270, [double]$script:Settings.width)
$script:Window.Height = [Math]::Max(300, [double]$script:Settings.height)
$script:Window.Topmost = [bool]$script:Settings.alwaysOnTop

$script:Header.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)

    if ($eventArgs.ClickCount -eq 2) {
        Set-CollapsedState -Collapsed (-not [bool]$script:Settings.collapsed)
        return
    }

    if (-not [bool]$script:Settings.locked -and $eventArgs.ButtonState -eq [System.Windows.Input.MouseButtonState]::Pressed) {
        try {
            $script:Window.DragMove()
        }
        catch {
        }
    }
})

$script:AllFilterButton.Add_Click({ Set-Filter -Name "all" })
$script:TodayFilterButton.Add_Click({ Set-Filter -Name "today" })
$script:ImportantFilterButton.Add_Click({ Set-Filter -Name "important" })
$script:DoneFilterButton.Add_Click({ Set-Filter -Name "done" })

$script:AddButton.Add_Click({
    if ([bool]$script:Settings.collapsed) {
        Set-CollapsedState -Collapsed $false
    }
    $script:QuickAddPanel.Visibility = [System.Windows.Visibility]::Visible
    $script:NewTaskText.Focus() | Out-Null
})

$script:SaveNewTaskButton.Add_Click({ Add-TodoFromInput })
$script:CancelNewTaskButton.Add_Click({
    $script:NewTaskText.Clear()
    $script:QuickAddPanel.Visibility = [System.Windows.Visibility]::Collapsed
})

$script:NewTaskText.Add_KeyDown({
    param($sender, $eventArgs)

    if ($eventArgs.Key -eq [System.Windows.Input.Key]::Enter) {
        Add-TodoFromInput
        $eventArgs.Handled = $true
    }
    elseif ($eventArgs.Key -eq [System.Windows.Input.Key]::Escape) {
        $script:QuickAddPanel.Visibility = [System.Windows.Visibility]::Collapsed
        $eventArgs.Handled = $true
    }
})

$script:PinButton.Add_Click({
    $script:Window.Topmost = -not [bool]$script:Window.Topmost
    Update-ChromeState
    Save-Settings
})

$script:LockButton.Add_Click({
    $script:Settings.locked = -not [bool]$script:Settings.locked
    Update-ChromeState
    Save-Settings
})

$script:CollapseButton.Add_Click({
    Set-CollapsedState -Collapsed (-not [bool]$script:Settings.collapsed)
})

$script:CloseButton.Add_Click({
    $script:Window.Close()
})

$script:Window.Add_Closing({
    Save-Settings
})

Update-FilterButtons
Update-ChromeState
Render-Todos

if ([bool]$script:Settings.collapsed) {
    Set-CollapsedState -Collapsed $true
}

if ($SmokeTest) {
    "Smoke test OK"
    return
}

$null = $script:Window.ShowDialog()
